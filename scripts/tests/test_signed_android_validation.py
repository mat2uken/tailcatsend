import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('signed_validation', SCRIPTS / 'signed_android_validation.py')
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)
SHA = '5e0125797c2466918772a6722302d84219a1792a'


class GuardTests(unittest.TestCase):
    def test_unknown_modes_incomplete_source_and_unconfirmed_deploy_stop(self):
        validation.request('verify', SHA, 'false')
        validation.request('deploy', '', 'true')
        for mode, source, confirm in [('other', SHA, 'true'), ('', SHA, 'false'),
                                      ('verify', SHA[:8], 'false'), ('verify', SHA + '\n', 'false'),
                                      ('deploy', SHA, 'false'), ('deploy', SHA, 'TRUE')]:
            with self.assertRaises(validation.ValidationError):
                validation.request(mode, source, confirm)
        for key in ('ACTIONS_STEP_DEBUG', 'ACTIONS_RUNNER_DEBUG', 'RUNNER_DEBUG'):
            with self.assertRaises(validation.ValidationError):
                validation.debug_guard({key: 'true'})
        with self.assertRaises(validation.ValidationError):
            validation.debug_guard({'RUNNER_DEBUG': '1'})

    def test_private_environment_is_literal_and_rejects_extra_duplicate_or_wrong_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / 'env'
            key = Path(tmp) / 'key'
            safe = f'PONLET_ANDROID_KEYSTORE={key}\nANDROID_KEYSTORE_PASSWORD=$(touch injected)\nANDROID_KEY_ALIAS=alias\nANDROID_KEY_PASSWORD=pass\n'
            env.write_text(safe)
            self.assertEqual(validation.parse_private_env(env, key)['ANDROID_KEYSTORE_PASSWORD'], '$(touch injected)')
            for content in (safe + 'PLAY_CONFIG_JSON=evil\n', safe + 'ANDROID_KEY_ALIAS=again\n',
                            safe.replace(str(key), '/unexpected/key'), safe.replace('alias\n', 'alias\nINJECT=x\n')):
                env.write_text(content)
                with self.assertRaises(validation.ValidationError):
                    validation.parse_private_env(env, key)

    def test_failed_command_and_missing_graph_never_echo_private_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            captured = io.StringIO()
            for exit_code, require_graph in [(1, False), (0, True)]:
                with contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                    validation.run_private(['python3', '-c', f'print("PRIVATE_SENTINEL"); exit({exit_code})'],
                                           tmp, dict(os.environ), Path(tmp), 'fixture', require_graph)
            self.assertNotIn('PRIVATE_SENTINEL', captured.getvalue())
            events = [json.loads(line) for line in captured.getvalue().splitlines()]
            failures = [event for event in events if event['status'] == 'failed']
            self.assertEqual([event['return_code'] for event in failures], [1, 0])
            self.assertEqual([event['category'] for event in failures], ['unclassified', 'graph-marker-missing'])
            self.assertTrue(all('elapsed_seconds' in event and 'log_sha256' in event for event in failures))

    def test_failure_classifier_emits_fixed_enums_without_log_fragments(self):
        fixtures = [(b'PRIVATE_SENTINEL unknown error', 1, 'unclassified'),
                    (b'PRIVATE_SENTINEL No space left on device', 1, 'disk-space'),
                    (b'PRIVATE_SENTINEL java heap space', 1, 'memory'),
                    (b'PRIVATE_SENTINEL daemon disappeared', 1, 'gradle-daemon'),
                    (b'PRIVATE_SENTINEL Formatting issues found', 1, 'frontend-check'),
                    (b'PRIVATE_SENTINEL Cannot apply patch cleanly', 1, 'patches'),
                    (b'PRIVATE_SENTINEL unknown error', -9, 'process-killed')]
        for content, code, expected in fixtures:
            self.assertEqual(validation.failure_category(content, code), expected)
        with tempfile.TemporaryDirectory() as tmp:
            captured = io.StringIO()
            with contextlib.redirect_stderr(captured):
                validation.phase_event('build-apk', 'failed', tmp, validation.time.monotonic(),
                                       137, 'process-killed', 'a' * 64)
            event = json.loads(captured.getvalue())
            self.assertEqual(event['return_code'], 137)
            self.assertEqual(event['category'], 'process-killed')
            self.assertTrue(isinstance(event['disk_free_bytes'], int))
            self.assertNotIn(tmp, captured.getvalue())
            self.assertNotIn('PRIVATE_SENTINEL', captured.getvalue())
            self.assertLessEqual(set(event), {'validation_phase', 'status', 'elapsed_seconds', 'return_code',
                                              'category', 'log_sha256', 'disk_free_bytes', 'memory_available_bytes'})


    def test_base64_wrapping_is_accepted_but_invalid_chars_are_rejected(self):
        encoded = base64.b64encode(b'{"fixture": true}').decode()
        wrapped = ' \t' + encoded[:8] + '\r\n' + encoded[8:] + '\n'
        self.assertEqual(validation.decode_firebase(wrapped), b'{"fixture": true}')
        for bad in (encoded + '!', encoded + '\v', encoded + '非ASCII'):
            with self.assertRaises(ValueError):
                validation.decode_firebase(bad)

    def test_fallback_cleanup_removes_only_owned_inodes_and_private_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'repo'
            app = repo / 'apps/tauri/gen/android/app'
            app.mkdir(parents=True)
            config = app / 'google-services.json'
            config.write_text('OWNED_FIXTURE')
            original = app.parent / 'tauri.settings.gradle'
            original.write_text('ORIGINAL_UNOWNED')
            runner = Path(tmp) / 'runner'
            work = runner / 'ponlet-signed-validation-fixture'
            work.mkdir(parents=True)
            (work / 'secret.log').write_text('PRIVATE_FIXTURE')
            validation.record_ownership(work, repo, [config])
            validation.cleanup_owned(repo, runner)
            self.assertFalse(config.exists())
            self.assertFalse(work.exists())
            self.assertEqual(original.read_text(), 'ORIGINAL_UNOWNED')

    def test_failed_report_exposes_only_reviewed_enum_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'safe.json'
            report.write_text(json.dumps({'errors': ['PRIVATE_SENTINEL', 'signature_tool_failed'],
                                           'artifacts': [{'errors': ['artifact_validation_failed', 'secret=abc']}]}))
            self.assertEqual(validation.report_error_codes(report),
                             ['artifact_validation_failed', 'signature_tool_failed'])
            report.write_text('malformed PRIVATE_SENTINEL')
            self.assertEqual(validation.report_error_codes(report), [])

    def test_cancellation_terminates_private_child_process_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(subprocess, 'Popen') as popen, patch.object(os, 'killpg') as kill:
                popen.return_value.pid = 123456
                popen.return_value.wait.side_effect = [validation.ValidationError('cancelled'), 0]
                with self.assertRaises(validation.ValidationError):
                    validation.run_private(['fixture'], tmp, {}, Path(tmp), 'cancelled')
                kill.assert_called_once_with(123456, validation.signal.SIGTERM)
                self.assertTrue(popen.call_args.kwargs['start_new_session'])


class OpaqueBuildTests(unittest.TestCase):
    def fixture(self, root, fail=False):
        scripts = root / 'scripts'
        scripts.mkdir()
        app = root / 'apps/tauri/gen/android/app'
        app.mkdir(parents=True)
        (scripts / 'signed_android_no_upload.init.gradle').write_text((SCRIPTS / 'signed_android_no_upload.init.gradle').read_text())
        # Synthetic signing fixture only: no keytool, actual keystore or credentials.
        (scripts / 'setup_android_signing.sh').write_text('''#!/bin/bash
set -eu
printf 'NOT_A_REAL_KEY' > "$RUNNER_TEMP/ponlet-release.keystore"
printf 'PONLET_ANDROID_KEYSTORE=%s\nANDROID_KEYSTORE_PASSWORD=%s\nANDROID_KEY_ALIAS=%s\nANDROID_KEY_PASSWORD=%s\n' "$RUNNER_TEMP/ponlet-release.keystore" "$ANDROID_KEYSTORE_PASSWORD" "$ANDROID_KEY_ALIAS" "$ANDROID_KEY_PASSWORD" >> "$GITHUB_ENV"
echo PRIVATE_SIGNING_SENTINEL
''')
        (scripts / 'build_tauri_mobile.sh').write_text('''#!/bin/bash
set -eu
for key in ANDROID_KEYSTORE_BASE64 GOOGLE_SERVICES_JSON_BASE64 PLAY_CONFIG_JSON GITHUB_ENV; do
  test -z "${!key+x}"
done
test "$PONLET_ANDROID_VERSION_CODE" = 2030000102
test "$PONLET_SIGNED_VALIDATION" = 1
test -f "$GRADLE_USER_HOME/init.d/signed-validation.gradle"
test -f "$PONLET_ANDROID_KEYSTORE"
echo PRIVATE_BUILD_SENTINEL
echo PONLET_SIGNED_VALIDATION_GRAPH_OK
''' + ('exit 9\n' if fail else '''if [ "$PONLET_ANDROID_ARTIFACT" = aab ]; then
  mkdir -p apps/tauri/gen/android/app/build/outputs/bundle/universalRelease
  echo FIXTURE > apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/app.aab
else
  mkdir -p apps/tauri/gen/android/app/build/outputs/apk/universal/release
  echo FIXTURE > apps/tauri/gen/android/app/build/outputs/apk/universal/release/app.apk
fi
'''))
        (scripts / 'verify_signed_android_release.py').write_text('''import json, os, sys
for key in ('ANDROID_KEYSTORE_BASE64','GOOGLE_SERVICES_JSON_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD','PONLET_ANDROID_KEYSTORE','GITHUB_ENV','PLAY_CONFIG_JSON'):
    assert key not in os.environ
from pathlib import Path
Path(sys.argv[sys.argv.index('--report') + 1]).write_text(json.dumps({'verified': True}))
print('PRIVATE_VERIFIER_SENTINEL')
''')
        (root / 'apps/tauri/Cargo.toml').write_text('[dependencies]\ntauri = "2"\ntauri-plugin-fixture = "2"\n')
        tauri = root / 'crate-tauri'
        plugin = root / 'crate-plugin'
        (tauri / 'mobile/android').mkdir(parents=True)
        (plugin / 'android').mkdir(parents=True)
        generator = root / 'crate-tauri-build'
        (generator / 'src').mkdir(parents=True)
        (generator / 'src/mobile.rs').write_text('androidx.lifecycle:lifecycle-process:2.10.0')
        metadata = {'packages': [{'name': 'tauri', 'manifest_path': str(tauri / 'Cargo.toml')},
                                 {'name': 'tauri-plugin-fixture', 'manifest_path': str(plugin / 'Cargo.toml')},
                                 {'name': 'tauri-build', 'manifest_path': str(generator / 'Cargo.toml')}]}
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        cargo = bin_dir / 'cargo'
        cargo.write_text('#!/usr/bin/env python3\nimport os\nassert "ANDROID_KEYSTORE_PASSWORD" not in os.environ\nassert "ANDROID_KEYSTORE_BASE64" not in os.environ\nprint(' + repr(json.dumps(metadata)) + ')\n')
        cargo.chmod(0o755)
        (app.parent / 'gradlew').write_text('''#!/bin/bash
set -eu
test "$1" = :app:bundleUniversalRelease
test "$2" = :app:assembleUniversalRelease
test "$3" = --dry-run
test -f tauri.settings.gradle
echo PRIVATE_GRAPH_SENTINEL
echo PONLET_SIGNED_VALIDATION_GRAPH_OK
''')
        temp = root / 'runner-temp'
        temp.mkdir()
        sdk = root / 'sdk/build-tools/35.0.0'
        sdk.mkdir(parents=True)
        (sdk / 'apksigner').touch()
        global_env = root / 'job.env'
        global_env.write_text('UNCHANGED=1\n')
        firebase = {'project_info': {'project_id': 'ponlet-599c4'}, 'client': [{'client_info': {'android_client_info': {'package_name': 'jp.yasagure.ponlet'}}}]}
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], RUNNER_TEMP=str(temp), JAVA_HOME=str(root / 'jdk'),
                   ANDROID_HOME=str(root / 'sdk'), GITHUB_ENV=str(global_env),
                   PLAY_CONFIG_JSON='AMBIENT_PLAY_SENTINEL',
                   GOOGLE_SERVICES_JSON_BASE64=base64.b64encode(json.dumps(firebase).encode()).decode())
        env.update({key: 'TEST_ONLY_INPUT' for key in validation.SIGNING_KEYS})
        return app, env, global_env, temp

    def test_success_uses_opaque_credentials_without_job_env_or_log_leak(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root)
            captured = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA + '\n'), contextlib.redirect_stdout(captured):
                validation.validate(root, SHA, env)
            for token in ('PRIVATE_', 'TEST_ONLY_INPUT', 'AMBIENT_PLAY_SENTINEL'):
                self.assertNotIn(token, captured.getvalue())
            self.assertEqual(json.loads(captured.getvalue())['version_code'], 2030000102)
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.iterdir()), [])

    def test_failed_build_cleans_inputs_and_private_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root, fail=True)
            captured = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA + '\n'), contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                validation.validate(root, SHA, env)
            self.assertNotIn('PRIVATE_', captured.getvalue())
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.iterdir()), [])
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')

    def test_failed_preflight_graph_stops_before_either_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            (app.parent / 'gradlew').write_text('echo PRIVATE_GRAPH_FAILURE; exit 9')
            with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(validation.ValidationError):
                validation.validate(root, SHA, env)
            self.assertFalse((app / 'build/outputs').exists())
            self.assertFalse((app / 'google-services.json').exists())
            self.assertFalse((app / 'tauri.build.gradle.kts').exists())
            self.assertFalse((app.parent / 'tauri.settings.gradle').exists())
            self.assertEqual(list(temp.iterdir()), [])

    def test_tracked_plugin_metadata_missing_duplicate_and_existing_files_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, _, _, _ = self.fixture(root)
            settings = app.parent / 'tauri.settings.gradle'
            metadata = {'packages': [{'name': name, 'manifest_path': str(root / directory / 'Cargo.toml')}
                                     for name, directory in [('tauri', 'crate-tauri'),
                                                             ('tauri-plugin-fixture', 'crate-plugin'),
                                                             ('tauri-build', 'crate-tauri-build')]]}
            for packages in (metadata['packages'][:-1], metadata['packages'] + [metadata['packages'][0]]):
                with self.assertRaises(validation.ValidationError):
                    validation.prepare_tauri_settings(root, {'packages': packages}, settings)
                self.assertFalse(settings.exists())
                self.assertFalse((app / 'tauri.build.gradle.kts').exists())
            validation.prepare_tauri_settings(root, metadata, settings)
            original = settings.read_text()
            self.assertEqual(original.count("include ':tauri-android'"), 1)
            self.assertIn('lifecycle-process:2.10.0', (app / 'tauri.build.gradle.kts').read_text())
            with self.assertRaises(validation.ValidationError):
                validation.prepare_tauri_settings(root, metadata, settings)
            self.assertEqual(settings.read_text(), original)

    def test_stale_source_and_existing_config_fail_before_signing_or_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            config = app / 'google-services.json'
            config.write_text('ORIGINAL_CONFIG')
            for head in ('0' * 40, SHA):
                with patch.object(subprocess, 'check_output', return_value=head), self.assertRaises(validation.ValidationError):
                    validation.validate(root, SHA, env)
                self.assertEqual(config.read_text(), 'ORIGINAL_CONFIG')
                self.assertEqual(list(temp.iterdir()), [])

    def test_validation_job_has_no_deployment_or_publication_steps(self):
        # Pure source check complements execution fixtures; no YAML dependency required.
        workflow = (SCRIPTS.parent / '.github/workflows/google_play.yml').read_text()
        job = workflow.split('  signed-validation:', 1)[1].split('  build-and-deploy:', 1)[0]
        for forbidden in ('PLAY_CONFIG_JSON', 'upload-artifact', 'upload-google-play', 'cache: npm',
                          'cache-dependency-path', 'gh release', 'setup_android_signing.sh'):
            self.assertNotIn(forbidden, job)
        self.assertIn('cache: false', job)
        self.assertIn('persist-credentials: false', job)
        self.assertIn("inputs.mode == 'verify'", job)
        self.assertIn("inputs.confirm_deploy == true", workflow)
        self.assertIn('default: verify', workflow)
        init = (SCRIPTS / 'signed_android_no_upload.init.gradle').read_text()
        self.assertIn('gradle.taskGraph.whenReady', init)
        self.assertIn('blocked(it) && it.enabled', init)
        self.assertIn('mappingFileUploadEnabled = false', init)
        self.assertIn('nativeSymbolUploadEnabled = false', init)


if __name__ == '__main__':
    unittest.main()
