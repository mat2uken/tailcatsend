import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT_DIR = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("android_code", SCRIPT_DIR / "android_version_code.py")
code = importlib.util.module_from_spec(spec)
spec.loader.exec_module(code)


class VersionCodeTests(unittest.TestCase):
    def test_attempt_and_next_run_order_without_date_wrap(self):
        first = code.build_number(37, 1, code.LEGACY_MAX)
        rerun = code.build_number(37, 99, first)
        next_run = code.build_number(38, 1, rerun)
        self.assertLess(code.LEGACY_MAX, first)
        self.assertLess(first, rerun)
        self.assertLess(rerun, next_run)

    def test_confirmed_maximum_recovers_old_rerun_and_other_workflow(self):
        uploaded = code.build_number(10000, 1, code.LEGACY_MAX)
        rerun = code.build_number(37, 2, uploaded)
        other_workflow = code.build_number(1, 1, rerun)
        self.assertEqual(rerun, uploaded + 1)
        self.assertEqual(other_workflow, rerun + 1)
        # The final candidate recheck still rejects a stale/reused artifact.
        with self.assertRaises(ValueError):
            code.require_newer(uploaded, other_workflow)

    def test_console_maximum_takes_priority_and_exhaustion_stops(self):
        previous = code.PLAY_MAX - 1
        self.assertEqual(code.build_number(1, 1, previous), code.PLAY_MAX)
        with self.assertRaises(ValueError):
            code.build_number(1, 1, code.PLAY_MAX)

    def test_capacity_and_untrusted_console_input(self):
        self.assertLessEqual(code.build_number(700000, 99, code.LEGACY_MAX), code.PLAY_MAX)
        for run, attempt in [(0, 1), (1, 0), (1, 100), (700001, 1)]:
            with self.assertRaises(ValueError):
                code.build_number(run, attempt, code.LEGACY_MAX)
        for value in ["0", "01", "-1", "2100000001", "1;echo bad", "２", "1\n"]:
            with self.assertRaises(ValueError):
                code.validate_code(value)

    def test_cli_does_not_export_invalid_or_stale_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            envfile = Path(tmp) / "env"
            envfile.write_text("UNCHANGED=1\n")
            result = subprocess.run(
                [sys.executable, str(SCRIPT_DIR / "android_version_code.py"),
                 "--candidate", "2030000001", "--previous", "2030000001",
                 "--github-env", str(envfile)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(envfile.read_text(), "UNCHANGED=1\n")


class BuildOnlyTests(unittest.TestCase):
    def test_wrapper_clears_existing_credentials_for_both_release_formats(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wrapper = root / "build_android_verify.sh"
            wrapper.write_text((SCRIPT_DIR / wrapper.name).read_text())
            stub = root / "build_tauri_mobile.sh"
            stub.write_text("""#!/usr/bin/env bash
set -euo pipefail
test "$PONLET_ANDROID_BUILD_ONLY" = 1
test "$CARGO_PROFILE_RELEASE_STRIP" = none
for key in PONLET_ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD PLAY_CONFIG_JSON GOOGLE_SERVICES_JSON_BASE64; do
  test -z "${!key+x}"
done
printf '%s %s %s\\n' "$1" "$2" "$PONLET_ANDROID_ARTIFACT" >> "$TEST_LOG"
""")
            stub.chmod(0o755)
            log = root / "calls"
            env = dict(os.environ, TEST_LOG=str(log))
            for key in ["PONLET_ANDROID_KEYSTORE", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS",
                        "ANDROID_KEY_PASSWORD", "PLAY_CONFIG_JSON", "GOOGLE_SERVICES_JSON_BASE64"]:
                env[key] = "test-only-placeholder"
            subprocess.run(["bash", str(wrapper)], env=env, check=True)
            self.assertEqual(log.read_text().splitlines(), ["android release aab", "android release apk"])


if __name__ == "__main__":
    unittest.main()
