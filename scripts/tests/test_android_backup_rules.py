from pathlib import Path, PurePosixPath
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
MAIN = ROOT / "apps/tauri/gen/android/app/src/main"
ANDROID = "{http://schemas.android.com/apk/res/android}"
TOOLS = "{http://schemas.android.com/tools}"


def eligible(section, domain, relative_path):
    """Evaluate the documented directory-recursive exclusion semantics.

    These policy cases exercise scope; this is not an Android transport emulator.
    """
    path = PurePosixPath(relative_path)
    for rule in section.findall("exclude"):
        if rule.attrib["domain"] != domain:
            continue
        excluded = PurePosixPath(rule.attrib["path"])
        if path == excluded or excluded in path.parents:
            return False
    return True


class AndroidBackupRulesTests(unittest.TestCase):
    def setUp(self):
        self.manifest = ET.parse(MAIN / "AndroidManifest.xml").getroot()
        self.app = self.manifest.find("application")
        self.modern = ET.parse(MAIN / "res/xml/data_extraction_rules.xml").getroot()
        self.legacy = ET.parse(MAIN / "res/xml/backup_rules.xml").getroot()

    def test_manifest_keeps_backup_enabled_and_references_both_api_formats(self):
        self.assertEqual(self.app.attrib[ANDROID + "allowBackup"], "true")
        self.assertEqual(self.app.attrib[ANDROID + "fullBackupContent"], "@xml/backup_rules")
        self.assertEqual(self.app.attrib[ANDROID + "dataExtractionRules"], "@xml/data_extraction_rules")
        gradle = (MAIN.parents[1] / "build.gradle.kts").read_text()
        self.assertIn("minSdk = 31", gradle)

    def test_cloud_excludes_received_recursively_but_keeps_siblings_and_preferences(self):
        cloud = self.modern.find("cloud-backup")
        self.assertEqual(len(cloud.findall("exclude")), 2)
        self.assertEqual(cloud.findall("include"), [])
        for path in ["received", "received/document.pdf", "received/nested/画像.png"]:
            self.assertFalse(eligible(cloud, "file", path), path)
        for domain, path in [("file", "received-old/document.pdf"),
                             ("file", "received.txt"), ("file", "other/received/document.pdf"),
                             ("file", "settings.json"), ("sharedpref", "telemetry.xml"),
                             ("database", "received"), ("external", "received/document.pdf")]:
            self.assertTrue(eligible(cloud, domain, path), (domain, path))

    def test_device_transfer_excludes_only_private_deletion_state(self):
        d2d = self.modern.find("device-transfer")
        self.assertIsNotNone(d2d)
        self.assertEqual([rule.attrib for rule in d2d],
                         [{"domain": "sharedpref", "path": "ponlet_privacy_state.xml"}])
        for domain, path in [("file", "received/document.pdf"), ("file", "settings.json"),
                             ("sharedpref", "telemetry.xml")]:
            self.assertTrue(eligible(d2d, domain, path))

    def test_legacy_format_excludes_received_and_private_state(self):
        self.assertEqual(self.legacy.tag, "full-backup-content")
        self.assertEqual(self.legacy.findall("include"), [])
        self.assertEqual([rule.attrib for rule in self.legacy.findall("exclude")],
                         [{"domain": "file", "path": "received/"},
                          {"domain": "sharedpref", "path": "ponlet_privacy_state.xml"}])
        self.assertFalse(eligible(self.legacy, "file", "received/nested/file"))
        self.assertTrue(eligible(self.legacy, "file", "received-backup/file"))
        self.assertTrue(eligible(self.legacy, "sharedpref", "telemetry.xml"))

    def test_private_state_excluded_but_saved_opt_out_remains_in_both_formats(self):
        for section in (self.legacy, self.modern.find("cloud-backup"), self.modern.find("device-transfer")):
            self.assertFalse(eligible(section, "sharedpref", "ponlet_privacy_state.xml"))
            self.assertTrue(eligible(section, "sharedpref", "telemetry_prefs.xml"))
            self.assertTrue(eligible(section, "sharedpref", "other_preferences.xml"))

    def test_advertising_controls_preserve_non_ad_permissions_and_sdk_startup_gate(self):
        removal = {p.attrib[ANDROID + "name"] for p in self.manifest.findall("uses-permission")
                   if p.attrib.get(TOOLS + "node") == "remove"}
        self.assertEqual(removal, {"com.google.android.gms.permission.AD_ID",
                                  "android.permission.ACCESS_ADSERVICES_AD_ID",
                                  "android.permission.ACCESS_ADSERVICES_ATTRIBUTION"})
        retained = {p.attrib[ANDROID + "name"] for p in self.manifest.findall("uses-permission")
                    if p.attrib.get(TOOLS + "node") != "remove"}
        self.assertTrue({"android.permission.INTERNET", "android.permission.CAMERA"} <= retained)
        metadata = {item.attrib[ANDROID + "name"]: item.attrib.get(ANDROID + "value")
                    for item in self.app.findall("meta-data")}
        for name in ["google_analytics_adid_collection_enabled",
                     "google_analytics_default_allow_ad_personalization_signals"]:
            self.assertEqual(metadata[name], "false")
        self.assertNotIn("firebase_analytics_collection_deactivated", metadata)
        plugin = ET.parse(ROOT / "crates/tauri-plugin-ponlet-platform/android/src/main/AndroidManifest.xml")
        startup = {item.attrib[ANDROID + "name"]: item.attrib.get(ANDROID + "value")
                   for item in plugin.getroot().find("application").findall("meta-data")}
        self.assertEqual(startup["firebase_analytics_collection_enabled"], "false")
        self.assertEqual(startup["firebase_crashlytics_collection_enabled"], "false")


if __name__ == "__main__":
    unittest.main()
