import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import verify_android_privacy as privacy

spec = importlib.util.spec_from_file_location('privacy_artifact_fixtures', SCRIPTS / 'tests/test_android_artifacts.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
A = privacy.A


def manifest(mode='feature-on-closed'):
    enabled = mode == 'feature-on-closed'
    nodes = []
    for name, value in (
        ('ponlet_privacy_feature_enabled', enabled),
        ('ponlet_privacy_components_verified', False),
        ('ponlet_privacy_protocol_verified', False),
        ('firebase_analytics_collection_enabled', False),
        ('firebase_crashlytics_collection_enabled', False),
    ):
        nodes.append(fixtures.node('meta-data', [('name', name), ('value', str(value).lower())]))
    for name in privacy.EMPTY_CONFIG:
        nodes.append(fixtures.node('meta-data', [('name', 'ponlet_privacy_' + name), ('value', '')]))
    nodes.append(fixtures.node('meta-data', [('name', 'ponlet_privacy_backup_rules_version'), ('value', '1')]))
    nodes.append(fixtures.node('meta-data', [('name', 'secret'), ('value', 'DO_NOT_REPORT_SENTINEL')]))
    for tag, name in privacy.COMPONENTS:
        attributes = [('name', name), ('enabled', str(not enabled).lower())]
        if tag == 'provider':
            attributes.append(('initOrder', '100'))
        nodes.append(fixtures.node(tag, attributes))
    nodes.append(fixtures.node('provider', [('name', privacy.STARTUP), ('initOrder', '1000'),
        ('authorities', 'jp.yasagure.ponlet.ponlet.privacy.startup'), ('exported', 'false')]))
    nodes.append(fixtures.node('service', [('name', 'com.google.firebase.components.ComponentDiscoveryService'),
                                         ('exported', 'false')]))
    return fixtures.node('manifest', [('package', 'jp.yasagure.ponlet')], [fixtures.node('application',
        [('allowBackup', 'true'), ('fullBackupContent', '@0x7f010000'),
         ('dataExtractionRules', '@0x7f010001')], nodes)])


def backup(kind):
    private = fixtures.plain_node('exclude', [('domain', 'sharedpref'), ('path', 'ponlet_privacy_state.xml')])
    received = fixtures.plain_node('exclude', [('domain', 'file'), ('path', 'received/')])
    if kind == 'legacy':
        return fixtures.plain_node('full-backup-content', children=[received, private])
    return fixtures.plain_node('data-extraction-rules', children=[
        fixtures.plain_node('cloud-backup', children=[received, private]),
        fixtures.plain_node('device-transfer', children=[private])])


def artifact(folder, aab=True, mode='feature-on-closed', xml=None, alias=False, variant=None, overrides=None):
    path = Path(folder) / ('test.aab' if aab else 'test.apk')
    members = {}
    xml = manifest(mode) if xml is None else xml
    if aab:
        members['BundleConfig.pb'] = b''
        members['base/manifest/AndroidManifest.xml'] = xml
        members['base/resources.pb'] = fixtures.proto_resources([variant] if variant else [], alias=alias)
    else:
        members['AndroidManifest.xml'] = fixtures.binary_manifest(xml)
        members['resources.arsc'] = fixtures.binary_resources(alias=alias)
    for kind, name in [('legacy', 'backup_rules'), ('modern', 'data_extraction_rules')]:
        value = backup(kind)
        members[('base/' if aab else '') + 'res/xml/' + name + '.xml'] = value if aab else fixtures.binary_manifest(value)
    members.update(overrides or {})
    with zipfile.ZipFile(path, 'w') as archive:
        for name, value in members.items():
            archive.writestr(name, value)
    return path


class PrivacyManifestTests(unittest.TestCase):
    def root(self, mode='feature-on-closed'):
        return privacy.base.proto_xml(manifest(mode))

    def test_both_real_build_modes_have_closed_release_gates(self):
        for mode in privacy.MODES:
            report = privacy.verify_manifest(self.root(mode), mode)
            self.assertTrue(report['release_gates_closed'])
            self.assertTrue(report['sdk_collection_disabled_until_saved_preference_is_read'])
            self.assertNotIn('DO_NOT_REPORT_SENTINEL', json.dumps(report))

    def test_string_false_cannot_masquerade_as_compiled_boolean(self):
        root = self.root()
        privacy.singleton(privacy.base.application(root), 'meta-data', 'ponlet_privacy_protocol_verified').set(A + 'value', 'false')
        with self.assertRaises(privacy.base.InvalidArtifact):
            privacy.verify_manifest(root, 'feature-on-closed')

    def test_metadata_resource_cannot_override_value_for_every_checked_flag(self):
        names = ['ponlet_privacy_feature_enabled', 'ponlet_privacy_components_verified',
                 'ponlet_privacy_protocol_verified', 'firebase_analytics_collection_enabled',
                 'firebase_crashlytics_collection_enabled', 'ponlet_privacy_backup_rules_version']
        for mode in privacy.MODES:
            for name in names:
                for compiled in (False, True):
                    with self.subTest(mode=mode, name=name, compiled=compiled), self.assertRaises(privacy.base.InvalidArtifact):
                        root = self.root(mode)
                        privacy.singleton(privacy.base.application(root), 'meta-data', name).set(A + 'resource', '@0x7f010099')
                        privacy.verify_manifest(root, mode, compiled=compiled)

    def test_init_order_only_accepted_in_unchanged_default_application_process(self):
        for mode in privacy.MODES:
            for target in ('application', privacy.STARTUP, privacy.COMPONENTS[0][1]):
                for process in (':privacy_only', 'jp.yasagure.ponlet', ''):
                    with self.subTest(mode=mode, target=target, process=process), self.assertRaises(privacy.base.InvalidArtifact):
                        root = self.root(mode); app = privacy.base.application(root)
                        node = app if target == 'application' else privacy.singleton(app, 'provider', target)
                        node.set(A + 'process', process)
                        privacy.verify_manifest(root, mode)

    def test_every_gate_configuration_and_sdk_default_fails_closed(self):
        cases = [('ponlet_privacy_components_verified', privacy.base.CompiledBoolean('true')),
                 ('ponlet_privacy_protocol_verified', privacy.base.CompiledBoolean('true')),
                 ('ponlet_privacy_feature_enabled', privacy.base.CompiledBoolean('false')),
                 ('firebase_analytics_collection_enabled', privacy.base.CompiledBoolean('true')),
                 ('firebase_crashlytics_collection_enabled', privacy.base.CompiledBoolean('true'))]
        cases += [('ponlet_privacy_' + name, 'UNEXPECTED_VALUE') for name in privacy.EMPTY_CONFIG]
        for name, value in cases:
            with self.subTest(name=name), self.assertRaises(privacy.base.InvalidArtifact):
                root = self.root()
                privacy.singleton(privacy.base.application(root), 'meta-data', name).set(A + 'value', value)
                privacy.verify_manifest(root, 'feature-on-closed')

    def test_missing_and_duplicate_metadata_rejected(self):
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate), self.assertRaises(privacy.base.InvalidArtifact):
                root = self.root(); app = privacy.base.application(root)
                node = privacy.singleton(app, 'meta-data', 'ponlet_privacy_feature_enabled')
                app.append(copy.deepcopy(node)) if duplicate else app.remove(node)
                privacy.verify_manifest(root, 'feature-on-closed')

    def test_all_six_components_must_match_feature_mode(self):
        for tag, name in privacy.COMPONENTS:
            with self.subTest(name=name), self.assertRaises(privacy.base.InvalidArtifact):
                root = self.root()
                privacy.singleton(privacy.base.application(root), tag, name).set(A + 'enabled', privacy.base.CompiledBoolean('true'))
                privacy.verify_manifest(root, 'feature-on-closed')

    def test_startup_provider_not_exported_early_enabled_and_resolved(self):
        for attribute, value in [('exported', privacy.base.CompiledBoolean('true')), ('initOrder', '50'),
                                 ('enabled', privacy.base.CompiledBoolean('false')), ('authorities', '${applicationId}')]:
            with self.subTest(attribute=attribute), self.assertRaises(privacy.base.InvalidArtifact):
                root = self.root()
                privacy.singleton(privacy.base.application(root), 'provider', privacy.STARTUP).set(A + attribute, value)
                privacy.verify_manifest(root, 'feature-on-closed')

    def test_unknown_sdk_components_and_active_discovery_need_review(self):
        for discovery in (False, True):
            with self.subTest(discovery=discovery), self.assertRaises(privacy.base.InvalidArtifact):
                root = self.root(); app = privacy.base.application(root)
                if discovery:
                    node = privacy.singleton(app, 'service', 'com.google.firebase.components.ComponentDiscoveryService')
                    ET.SubElement(node, 'intent-filter')
                else:
                    ET.SubElement(app, 'service', {A + 'name': 'com.google.firebase.NewUploader'})
                privacy.verify_manifest(root, 'feature-on-closed')

    def test_plain_merged_manifest_does_not_accept_unresolved_placeholders(self):
        root = ET.fromstring(ET.tostring(self.root()))
        privacy.verify_manifest(root, 'feature-on-closed', compiled=False)
        privacy.singleton(privacy.base.application(root), 'meta-data', 'ponlet_privacy_feature_enabled').set(A + 'value', '${ponletPrivacyFeatureEnabled}')
        with self.assertRaises(privacy.base.InvalidArtifact):
            privacy.verify_manifest(root, 'feature-on-closed', compiled=False)

    def test_known_transport_discovery_requires_nonexported_passive_shape(self):
        root = self.root(); app = privacy.base.application(root)
        discovery = ET.SubElement(app, 'service', {A + 'name': 'com.google.android.datatransport.runtime.backends.TransportBackendDiscovery',
            A + 'exported': privacy.base.CompiledBoolean('false')})
        privacy.verify_manifest(root, 'feature-on-closed')
        ET.SubElement(discovery, 'intent-filter')
        with self.assertRaises(privacy.base.InvalidArtifact):
            privacy.verify_manifest(root, 'feature-on-closed')

    def test_sessions_service_only_allowed_explicitly_disabled(self):
        root = self.root(); app = privacy.base.application(root)
        session = ET.SubElement(app, 'service', {A + 'name': 'com.google.firebase.sessions.SessionLifecycleService',
            A + 'exported': privacy.base.CompiledBoolean('false'), A + 'enabled': privacy.base.CompiledBoolean('false')})
        privacy.verify_manifest(root, 'feature-on-closed')
        session.set(A + 'enabled', privacy.base.CompiledBoolean('true'))
        with self.assertRaises(privacy.base.InvalidArtifact):
            privacy.verify_manifest(root, 'feature-on-closed')


class PrivacyBackupTests(unittest.TestCase):
    def test_both_formats_exclude_only_private_state_and_received_cloud(self):
        for kind, xml in [('fullBackupContent', backup('legacy')), ('dataExtractionRules', backup('modern'))]:
            self.assertTrue(privacy.privacy_backup_policy(kind, privacy.base.proto_xml(xml))['legacy_opt_out_preserved'])

    def test_mutations_of_private_received_or_legacy_optout_exclusions_fail(self):
        for kind in ('legacy', 'modern'):
            for domain, path in [('sharedpref', 'telemetry_prefs.xml'), ('sharedpref', '.'), ('file', 'received-other/'),
                                 ('file', 'ponlet_privacy_state.xml')]:
                with self.subTest(kind=kind, domain=domain, path=path), self.assertRaises(privacy.base.InvalidArtifact):
                    root = privacy.base.proto_xml(backup(kind))
                    section = root if kind == 'legacy' else root.find('cloud-backup')
                    section[-1].set('domain', domain); section[-1].set('path', path)
                    privacy.privacy_backup_policy('fullBackupContent' if kind == 'legacy' else 'dataExtractionRules', root)

    def test_missing_extra_and_duplicate_exclusions_fail(self):
        for action in ('missing', 'extra', 'duplicate', 'include'):
            with self.subTest(action=action), self.assertRaises(privacy.base.InvalidArtifact):
                root = privacy.base.proto_xml(backup('modern')); section = root.find('device-transfer')
                if action == 'missing': section.remove(section[0])
                elif action == 'extra': ET.SubElement(section, 'exclude', {'domain': 'file', 'path': 'received/'})
                elif action == 'duplicate': section.append(copy.deepcopy(section[0]))
                else: section[0].tag = 'include'
                privacy.privacy_backup_policy('dataExtractionRules', root)


class PrivacyArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_compiled_apk_and_aab_both_modes(self):
        for aab in (False, True):
            for mode in privacy.MODES:
                with self.subTest(aab=aab, mode=mode):
                    report = privacy.verify_artifact(artifact(self.root, aab, mode), mode)
                    self.assertEqual(report['status'], 'passed', report)
                    self.assertNotIn('DO_NOT_REPORT_SENTINEL', json.dumps(report))

    def test_referenced_xml_alias_missing_and_unchecked_configuration_fail(self):
        for aab in (False, True):
            report = privacy.verify_artifact(artifact(self.root, aab, alias=True), 'feature-on-closed')
            self.assertEqual(report['status'], 'failed', report)
        path = artifact(self.root, variant='res/xml-v36/backup_rules.xml')
        self.assertEqual(privacy.verify_artifact(path, 'feature-on-closed')['status'], 'failed')
        path = artifact(self.root, variant='res/xml-v36/backup_rules.xml', overrides={
            'base/res/xml-v36/backup_rules.xml': fixtures.backup_xml('legacy')})
        self.assertEqual(privacy.verify_artifact(path, 'feature-on-closed')['status'], 'failed')

    def test_corrupt_archive_wrong_mode_and_secret_never_escape(self):
        path = artifact(self.root)
        self.assertEqual(privacy.verify_artifact(path, 'default-off')['status'], 'failed')
        path.write_bytes(b'DO_NOT_REPORT_SENTINEL')
        report = privacy.verify_artifact(path, 'feature-on-closed')
        self.assertEqual(report['status'], 'failed')
        self.assertNotIn('DO_NOT_REPORT_SENTINEL', json.dumps(report))

    def test_merged_manifest_discovery_requires_release_and_nonempty_output(self):
        with self.assertRaises(privacy.base.InvalidArtifact):
            privacy.verify_merged(self.root, 'feature-on-closed')
        target = self.root / 'intermediates/merged_manifests/universalRelease/processUniversalReleaseManifest/AndroidManifest.xml'
        target.parent.mkdir(parents=True)
        target.write_bytes(ET.tostring(privacy.base.proto_xml(manifest())))
        self.assertEqual(len(privacy.verify_merged(self.root, 'feature-on-closed')), 1)

    def test_cli_requires_pair_and_emits_real_checks_report(self):
        paths = [artifact(self.root, aab) for aab in (False, True)]
        target = self.root / 'intermediates/merged_manifest/arm64Release/processReleaseManifest/AndroidManifest.xml'
        target.parent.mkdir(parents=True)
        target.write_bytes(ET.tostring(privacy.base.proto_xml(manifest())))
        report = self.root / 'report.json'
        args = ['--mode', 'feature-on-closed', '--build-dir', str(self.root), '--report', str(report)]
        self.assertEqual(privacy.main([str(p) for p in paths] + args), 0)
        self.assertEqual(privacy.main([str(paths[0])] + args), 1)
        self.assertNotIn('DO_NOT_REPORT_SENTINEL', report.read_text())


class PrivacyBuildOnlyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); scripts = self.root / 'scripts'; scripts.mkdir()
        for name in ('build_android_privacy_verify.sh', 'build_android_verify.sh'):
            shutil.copyfile(SCRIPTS / name, scripts / name)
        stub = scripts / 'build_tauri_mobile.sh'
        stub.write_text('''#!/usr/bin/env bash
set -euo pipefail
test "$PONLET_ANDROID_BUILD_ONLY" = 1
test "$ORG_GRADLE_PROJECT_ponletPrivacyComponentsVerified" = false
test "$ORG_GRADLE_PROJECT_ponletPrivacyProtocolVerified" = false
test -z "$ORG_GRADLE_PROJECT_ponletPrivacyApiOrigin"
test -z "$ORG_GRADLE_PROJECT_ponletPrivacyReceiptDays"
test "$NPM_CONFIG_IGNORE_SCRIPTS" = true
test "$NPM_CONFIG_USERCONFIG" = /dev/null
test "$NPM_CONFIG_REGISTRY" = https://registry.npmjs.org
for key in PONLET_ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD PLAY_CONFIG_JSON GOOGLE_SERVICES_JSON_BASE64 NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_TOKEN npm_config_token; do
  test -z "${!key+x}"
done
printf '%s %s %s %s\\n' "$1" "$2" "$PONLET_ANDROID_ARTIFACT" "${ORG_GRADLE_PROJECT_ponletPrivacyFeatureEnabled-absent}" >> "$TEST_LOG"
''')
        stub.chmod(0o755)
        self.log = self.root / 'calls'
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('ORG_GRADLE_PROJECT_ponletPrivacy') and k not in ('GRADLE_OPTS', 'JAVA_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS')}
        self.env.update(TEST_LOG=str(self.log), GRADLE_USER_HOME=str(self.root / 'gradle-home'))

    def run_mode(self, mode, **extra):
        return subprocess.run(['bash', str(self.root / 'scripts/build_android_privacy_verify.sh'), mode],
                              env=dict(self.env, **extra), capture_output=True, text=True)

    def test_default_property_absent_and_on_gate_closed_for_both_formats(self):
        for mode, feature in [('default-off', 'absent'), ('feature-on-closed', 'true')]:
            with self.subTest(mode=mode):
                if self.log.exists(): self.log.unlink()
                result = self.run_mode(mode, ORG_GRADLE_PROJECT_ponletPrivacyFeatureEnabled='true',
                    ORG_GRADLE_PROJECT_ponletPrivacyProtocolVerified='true', ORG_GRADLE_PROJECT_ponletPrivacyApiOrigin='private.invalid',
                    PONLET_ANDROID_KEYSTORE='test-only', ANDROID_KEY_ALIAS='test-only', PLAY_CONFIG_JSON='test-only',
                    NPM_TOKEN='test-only', NODE_AUTH_TOKEN='test-only', NPM_CONFIG_TOKEN='test-only', npm_config_token='test-only')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.log.read_text().splitlines(), [f'android release aab {feature}', f'android release apk {feature}'])

    def test_invalid_mode_never_invokes_build(self):
        self.assertNotEqual(self.run_mode('enable-release').returncode, 0)
        self.assertFalse(self.log.exists())

    def test_jvm_override_never_invokes_build_or_prints_value(self):
        result = self.run_mode('default-off', JAVA_TOOL_OPTIONS='-Dorg.gradle.project.ponletPrivacyApiOrigin=DO_NOT_REPORT_SENTINEL')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('DO_NOT_REPORT_SENTINEL', result.stderr + result.stdout)
        self.assertFalse(self.log.exists())

    def test_project_and_user_overrides_fail_before_build(self):
        for directory in ('apps/tauri/gen/android', 'gradle-home'):
            with self.subTest(directory=directory):
                file = self.root / directory / 'gradle.properties'; file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('ponletPrivacyProtocolVerified=true\n')
                self.assertNotEqual(self.run_mode('feature-on-closed').returncode, 0)
                self.assertFalse(self.log.exists()); file.unlink()

    def test_workflow_permissions_trigger_and_no_publication_stay_unchanged(self):
        workflow = (SCRIPTS.parent / '.github/workflows/android-build-only.yml').read_text()
        self.assertIn('permissions:\n  contents: read\n', workflow)
        self.assertIn('privacy: [default-off, feature-on-closed]', workflow)
        self.assertIn('submodules: true, persist-credentials: false', workflow)
        self.assertNotIn('secrets.', workflow)
        self.assertNotIn('upload-artifact', workflow)
        self.assertNotIn('pull_request_target', workflow)
        self.assertIn('verify_android_privacy.py', workflow)
        self.assertIn('--require-camera-optional --require-no-ad-id', workflow)


if __name__ == '__main__':
    unittest.main()
