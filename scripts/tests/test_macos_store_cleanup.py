"""Run failure paths against fake OS commands; never access a real keychain."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

BASH = '/bin/bash'  # Exercise the same system Bash 3.2 used on macOS runners.
SCRIPT = Path(__file__).resolve().parents[1] / 'build_macos_store_ci.sh'
SECRETS = (
    'MACOS_APP_CERT_P12', 'MACOS_APP_CERT_PASSWORD',
    'MACOS_INSTALLER_CERT_P12', 'MACOS_INSTALLER_CERT_PASSWORD',
    'MACOS_STORE_PROFILE_BASE64', 'MACOS_STORE_SHARE_PROFILE_BASE64', 'KEYCHAIN_PASSWORD',
)

class CleanupTests(unittest.TestCase):
    def test_missing_secret_never_calls_security(self):
        env = {'PATH': os.environ['PATH']}
        result = subprocess.run([BASH, str(SCRIPT)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Required secret is missing:', result.stderr)

    def test_keychain_creation_failure_restores_state_and_removes_scratch(self):
        self._assert_failure_cleanup("create-keychain")

    def test_import_failure_deletes_created_keychain(self):
        self._assert_failure_cleanup("import")

    def _assert_failure_cleanup(self, fail_command):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo = root / 'repo'
            scripts = repo / 'scripts'
            scripts.mkdir(parents=True)
            config = repo / 'apps/tauri/tauri.conf.json'
            config.parent.mkdir(parents=True)
            config.write_text('{"version":"1.0.18"}')
            shutil.copy2(SCRIPT, scripts / SCRIPT.name)
            shutil.copy2(SCRIPT.parent / 'macos_store_metadata.py', scripts / 'macos_store_metadata.py')
            binary = root / 'bin'
            binary.mkdir()
            log = root / 'commands'
            fake = {
                'uname': '#!/bin/sh\necho arm64\n',
                'git': '#!/bin/sh\nexit 0\n',
                'security': '''#!/bin/sh
printf '%s\n' "$1" >> "$MOCK_LOG"
if [ "$1" = "$MOCK_FAIL_COMMAND" ]; then exit 1; fi
case "$1" in
 list-keychains) if [ "$#" -eq 3 ]; then echo '"/tmp/original.keychain-db"'; fi ;;
 default-keychain) if [ "$#" -eq 3 ]; then echo '"/tmp/original.keychain-db"'; fi ;;
esac
exit 0
''',
            }
            for name, body in fake.items():
                path = binary / name
                path.write_text(body)
                path.chmod(0o755)
            env = {name: 'dummy-test-only' for name in SECRETS}
            for name in SECRETS:
                if name.endswith('_BASE64') or name.endswith('_P12'):
                    env[name] = base64.b64encode(b'non-sensitive fixture').decode()
            env.update(PATH=f"{binary}:{os.environ['PATH']}", MOCK_LOG=str(log), MOCK_FAIL_COMMAND=fail_command,
                       GITHUB_ACTIONS='true', GITHUB_RUN_NUMBER='123', GITHUB_RUN_ATTEMPT='1',
                       RUNNER_TEMP=str(root), PREVIOUS_STORE_BUILD='1.0.19', HOME=str(root))
            result = subprocess.run([BASH, str(scripts / SCRIPT.name)], env=env,
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('dummy-test-only', result.stdout + result.stderr)
            self.assertTrue(log.exists(), result.stderr)
            calls = log.read_text().splitlines()
            expected = ['list-keychains', 'default-keychain', 'create-keychain']
            if fail_command == 'import':
                expected += ['set-keychain-settings', 'unlock-keychain', 'import']
            expected += ['list-keychains', 'default-keychain']
            if fail_command == 'import':
                expected += ['delete-keychain']
            self.assertEqual(calls, expected)
            self.assertEqual(list(root.glob('ponlet-store.*')), [])
            self.assertFalse((repo / 'store-artifacts').exists())

if __name__ == '__main__':
    unittest.main()
