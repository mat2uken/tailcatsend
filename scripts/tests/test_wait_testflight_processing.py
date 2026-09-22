import copy
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from zipfile import ZipFile

SPEC = importlib.util.spec_from_file_location(
    "processing", Path(__file__).resolve().parents[1] / "wait_testflight_processing.py"
)
processing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(processing)

APP = {"data": [{"id": "app-id", "attributes": {"bundleId": "jp.yasagure.ponlet"}}]}


def build(state):
    return {
        "data": [{
            "attributes": {"version": "2026092401", "processingState": state},
            "relationships": {
                "app": {"data": {"id": "app-id"}},
                "preReleaseVersion": {"data": {"id": "version-id"}},
            },
        }],
        "included": [
            {"type": "apps", "id": "app-id", "attributes": {"bundleId": "jp.yasagure.ponlet"}},
            {"type": "preReleaseVersions", "id": "version-id", "attributes": {"version": "1.0.16", "platform": "IOS"}},
        ],
    }


class ProcessingTests(unittest.TestCase):
    def wait(self, responses, timeout=1200):
        now = [0]
        calls = []

        class Api:
            def get(self, path, params, request_timeout):
                calls.append((path, params, request_timeout))
                return APP if path == "apps" else responses.pop(0)

        def sleep(seconds):
            now[0] += seconds

        processing.wait_for_processing(
            Api(), "jp.yasagure.ponlet", "1.0.16", "2026092401",
            timeout=timeout, clock=lambda: now[0], sleep=sleep, log=lambda *a, **kw: None,
        )
        return calls

    def test_waits_for_visibility_and_validates_exact_identity(self):
        calls = self.wait([{"data": []}, build("PROCESSING"), build("VALID")])
        params = calls[-1][1]
        self.assertEqual(params["filter[app]"], "app-id")
        self.assertEqual(params["filter[version]"], "2026092401")
        self.assertEqual(params["filter[preReleaseVersion.version]"], "1.0.16")
        self.assertEqual(params["filter[preReleaseVersion.platform]"], "IOS")

    def test_terminal_failure_states(self):
        for state in ("FAILED", "INVALID"):
            with self.subTest(state=state), self.assertRaisesRegex(processing.ProcessingError, state):
                self.wait([build(state)])

    def test_timeout_does_not_accept_upload_or_processing(self):
        for payload in ({"data": []}, build("PROCESSING")):
            with self.subTest(payload=payload), self.assertRaisesRegex(processing.ProcessingError, "within 60s"):
                self.wait([payload, payload], timeout=60)

    def test_rejects_wrong_version_build_bundle_or_platform(self):
        for target, key, value in (
            ("build", "version", "old-build"),
            ("app", "bundleId", "wrong.app"),
            ("version", "version", "1.0.15"),
            ("version", "platform", "MAC_OS"),
        ):
            payload = build("VALID")
            attributes = (payload["data"][0]["attributes"] if target == "build" else
                          payload["included"][0 if target == "app" else 1]["attributes"])
            attributes[key] = value
            with self.subTest(target=target, key=key), self.assertRaisesRegex(processing.ProcessingError, "identity"):
                self.wait([payload])

    def test_rejects_ambiguous_or_unknown_state(self):
        duplicate = build("VALID")
        duplicate["data"].append(copy.deepcopy(duplicate["data"][0]))
        for payload in (duplicate, build("NEW_STATE")):
            with self.assertRaises(processing.ProcessingError):
                self.wait([payload])

    def test_jwt_and_api_errors_do_not_disclose_credentials(self):
        import jwt
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption

        private = ec.generate_private_key(ec.SECP256R1())
        pem = private.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
        env = {"APP_STORE_CONNECT_KEY_ID": "test-key", "APP_STORE_CONNECT_ISSUER_ID": "test-issuer",
               "APP_STORE_CONNECT_PRIVATE_KEY": pem}
        with patch.dict(processing.os.environ, env), patch.object(processing, "urlopen") as request:
            api = processing.AppStoreConnect()
            for failure, expected in (
                (HTTPError("https://api.appstoreconnect.apple.com", 403, "forbidden", {}, None), "HTTP 403"),
                (URLError("unavailable"), "network unavailable"),
            ):
                request.side_effect = failure
                with self.assertRaisesRegex(processing.ProcessingError, expected) as raised:
                    api.get("apps", {}, 30)
                self.assertNotIn(pem, str(raised.exception))
            token = request.call_args.args[0].get_header("Authorization").split(" ", 1)[1]
            claims = jwt.decode(token, private.public_key(), algorithms=["ES256"], audience="appstoreconnect-v1")
            self.assertEqual(claims["iss"], "test-issuer")
            self.assertEqual(claims["exp"] - claims["iat"], 120)
            self.assertEqual(jwt.get_unverified_header(token)["kid"], "test-key")


class IpaIdentityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.ipa = Path(self.directory.name) / "ponlet.ipa"
        self.config = Path(self.directory.name) / "tauri.conf.json"
        self.config.write_text(json.dumps({"identifier": "jp.yasagure.ponlet", "version": "1.0.16"}))
        self.info = {
            "CFBundleIdentifier": "jp.yasagure.ponlet",
            "CFBundleShortVersionString": "1.0.16",
            "CFBundleVersion": "1.0.16.2026092249",
        }

    def archive(self, extra_app=False):
        with ZipFile(self.ipa, "w") as ipa:
            ipa.writestr("Payload/Ponlet.app/Info.plist", plistlib.dumps(self.info, fmt=plistlib.FMT_BINARY))
            ipa.writestr("Payload/Ponlet.app/PlugIns/Share.appex/Info.plist", plistlib.dumps({
                "CFBundleIdentifier": "jp.yasagure.ponlet.sharek7vnga9k78",
                "CFBundleShortVersionString": "different", "CFBundleVersion": "extension-build",
            }))
            if extra_app:
                ipa.writestr("Payload/Other.app/Info.plist", plistlib.dumps(self.info))

    def test_main_uses_ipa_build_with_version_prefix_and_ignores_extension(self):
        self.archive()
        with patch.object(processing.sys, "argv", ["wait", "--version-config", str(self.config), "--ipa", str(self.ipa)]), \
                patch.object(processing, "AppStoreConnect") as api, \
                patch.object(processing, "wait_for_processing") as wait:
            self.assertEqual(processing.main(), 0)
            wait.assert_called_once_with(api.return_value, "jp.yasagure.ponlet", "1.0.16", "1.0.16.2026092249")

    def test_rejects_different_bundle_or_version(self):
        for key, value in (("CFBundleIdentifier", "wrong.app"), ("CFBundleShortVersionString", "1.0.15")):
            with self.subTest(key=key), patch.dict(self.info, {key: value}):
                self.archive()
                with self.assertRaisesRegex(processing.ProcessingError, "does not match"):
                    processing.ipa_identity(self.ipa, "jp.yasagure.ponlet", "1.0.16")

    def test_rejects_multiple_top_level_apps(self):
        self.archive(extra_app=True)
        with self.assertRaisesRegex(processing.ProcessingError, "exactly one"):
            processing.ipa_identity(self.ipa, "jp.yasagure.ponlet", "1.0.16")

    def test_rejects_missing_build_number(self):
        del self.info["CFBundleVersion"]
        self.archive()
        with self.assertRaisesRegex(processing.ProcessingError, "nonempty"):
            processing.ipa_identity(self.ipa, "jp.yasagure.ponlet", "1.0.16")

    def test_keeps_explicit_build_number_for_verification_only(self):
        with patch.object(processing.sys, "argv", ["wait", "--version-config", str(self.config), "--build-number", "1.0.16.2026092249"]), \
                patch.object(processing, "AppStoreConnect") as api, \
                patch.object(processing, "wait_for_processing") as wait:
            self.assertEqual(processing.main(), 0)
            wait.assert_called_once_with(api.return_value, "jp.yasagure.ponlet", "1.0.16", "1.0.16.2026092249")


if __name__ == "__main__":
    unittest.main()
