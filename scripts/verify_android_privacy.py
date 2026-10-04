#!/usr/bin/env python3
"""Read-only privacy checks of real merged manifests and compiled APK/AAB XML.

No Android app, Firebase API, network, credentials, or keys are used. This cannot
establish real SDK startup/background behavior, successful deletion, or release
readiness. Values outside the known booleans are never included in reports.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

import verify_android_artifacts as base

A = '{' + base.ANDROID + '}'
MODES = ('default-off', 'feature-on-closed')
COMPONENTS = (
    ('provider', 'com.google.firebase.provider.FirebaseInitProvider'),
    ('receiver', 'com.google.android.gms.measurement.AppMeasurementReceiver'),
    ('service', 'com.google.android.gms.measurement.AppMeasurementService'),
    ('service', 'com.google.android.gms.measurement.AppMeasurementJobService'),
    ('service', 'com.google.android.datatransport.runtime.scheduling.jobscheduling.JobInfoSchedulerService'),
    ('receiver', 'com.google.android.datatransport.runtime.scheduling.jobscheduling.AlarmManagerSchedulerBroadcastReceiver'),
)
STARTUP = 'jp.yasagure.ponlet.platform.PrivacyStartupProvider'
EMPTY_CONFIG = ('api_origin', 'audience', 'policy_version', 'receipt_days',
                'observation_days', 'retired_key_policy')
require = base.require


def singleton(app, tag, name):
    matches = [node for node in app.findall(tag) if node.get(A + 'name') == name]
    require(len(matches) == 1, f'expected one {tag}: {name}')
    return matches[0]


def boolean(node, key, expected, compiled, label):
    require(node.tag != 'meta-data' or node.get(A + 'resource') is None,
            f'{label} must not supply android:resource')
    value = node.get(A + key)
    require(value == ('true' if expected else 'false') and
            (not compiled or isinstance(value, base.CompiledBoolean)),
            f'{label} is not the required explicit boolean')


def verify_manifest(root, mode, compiled=True):
    require(mode in MODES, 'unknown privacy verification mode')
    require(root.tag == 'manifest' and root.get('package') == 'jp.yasagure.ponlet',
            'unexpected manifest package')
    app = base.application(root)
    require(app.get(A + 'process') is None, 'custom application process needs review')
    enabled = mode == 'feature-on-closed'
    for name, value in (
        ('ponlet_privacy_feature_enabled', enabled),
        ('ponlet_privacy_components_verified', False),
        ('ponlet_privacy_protocol_verified', False),
        ('firebase_analytics_collection_enabled', False),
        ('firebase_crashlytics_collection_enabled', False),
    ):
        boolean(singleton(app, 'meta-data', name), 'value', value, compiled, name)
    for name in EMPTY_CONFIG:
        node = singleton(app, 'meta-data', 'ponlet_privacy_' + name)
        require(node.get(A + 'value') == '' and node.get(A + 'resource') is None,
                f'non-empty or unresolved privacy configuration: {name}')
    backup_version = singleton(app, 'meta-data', 'ponlet_privacy_backup_rules_version')
    require(backup_version.get(A + 'value') == '1' and backup_version.get(A + 'resource') is None,
            'backup rules version must be 1')
    for tag, name in COMPONENTS:
        boolean(singleton(app, tag, name), 'enabled', not enabled, compiled, name)
    startup = singleton(app, 'provider', STARTUP)
    require(startup.get(A + 'process') is None, 'custom privacy provider process needs review')
    boolean(startup, 'exported', False, compiled, 'privacy startup exported')
    require(startup.get(A + 'enabled', 'true') == 'true', 'privacy startup provider must be enabled')
    require(startup.get(A + 'authorities') == 'jp.yasagure.ponlet.ponlet.privacy.startup',
            'privacy startup authority missing or unresolved')
    require(startup.get(A + 'initOrder') == '1000', 'privacy startup order must be 1000')
    firebase = singleton(app, 'provider', COMPONENTS[0][1])
    require(firebase.get(A + 'process') is None, 'custom Firebase provider process needs review')
    order = firebase.get(A + 'initOrder', '0')
    require(order.isdecimal() and int(order) < 1000, 'Firebase initializes before the privacy provider')
    # Unknown uploader/init entries need explicit review when the resolved SDK changes.
    known = {name for _, name in COMPONENTS}
    prefixes = ('com.google.firebase.', 'com.google.android.gms.measurement.',
                'com.google.android.datatransport.')
    additional = []
    for node in app:
        name = node.get(A + 'name', '')
        if node.tag not in ('provider', 'service', 'receiver') or not name.startswith(prefixes):
            continue
        if name in known:
            continue
        # Known metadata-only discovery entries. Their observed upstream shape
        # is not evidence of the runtime behavior of the resolved SDK version.
        passive = name in ('com.google.firebase.components.ComponentDiscoveryService',
                           'com.google.android.datatransport.runtime.backends.TransportBackendDiscovery')
        if passive:
            require(node.tag == 'service' and not node.findall('intent-filter'),
                    'Firebase discovery service is no longer passive')
            boolean(node, 'exported', False, compiled, 'Firebase discovery service exported')
        elif name == 'com.google.firebase.sessions.SessionLifecycleService':
            require(node.tag == 'service' and not node.findall('intent-filter'),
                    'Firebase sessions service shape needs review')
            boolean(node, 'enabled', False, compiled, 'Firebase sessions service enabled')
            boolean(node, 'exported', False, compiled, 'Firebase sessions service exported')
        else:
            additional.append(name)
    require(not additional, 'unreviewed Firebase/measurement/transport component inventory')
    return {'mode': mode, 'release_gates_closed': True, 'production_configuration_absent': True,
            'sdk_collection_disabled_until_saved_preference_is_read': True,
            'known_components': [name for _, name in COMPONENTS]}


def exact_exclusions(section, expected):
    require(section is not None and not section.attrib, 'backup section missing or has unexpected flags')
    found = []
    for node in section:
        require(node.tag == 'exclude' and len(node) == 0 and set(node.attrib) == {'domain', 'path'},
                'backup section must contain only exact exclusions')
        path = node.get('path')
        if node.get('domain') == 'file' and path == 'received':
            path = 'received/'
        found.append((node.get('domain'), path))
    require(len(found) == len(expected) and set(found) == set(expected),
            'backup scope differs from received/privacy-only exclusions')


def privacy_backup_policy(kind, root):
    private = ('sharedpref', 'ponlet_privacy_state.xml')
    received = ('file', 'received/')
    if kind == 'fullBackupContent':
        require(root.tag == 'full-backup-content', 'unexpected legacy backup root')
        exact_exclusions(root, [received, private])
    else:
        require(root.tag == 'data-extraction-rules' and not root.attrib and len(root) == 2,
                'data extraction must define only cloud and device transfer')
        clouds, transfers = root.findall('cloud-backup'), root.findall('device-transfer')
        require(len(clouds) == len(transfers) == 1, 'duplicate or missing backup section')
        exact_exclusions(clouds[0], [received, private])
        exact_exclusions(transfers[0], [private])
    return {'privacy_preferences_excluded': True, 'legacy_opt_out_preserved': True,
            'received_cloud_excluded': True, 'modern_received_device_transfer_preserved': True}


def verify_backup(root, archive, aab):
    app = base.application(root)
    boolean(app, 'allowBackup', True, True, 'allowBackup')
    name = 'base/resources.pb' if aab else 'resources.arsc'
    require(name in archive.namelist(), 'compiled resource table missing')
    paths, names = (base.proto_xml_resources if aab else base.binary_xml_resources)(archive.read(name))
    output = {}
    for kind in ('fullBackupContent', 'dataExtractionRules'):
        variants = []
        for path in base.resolve_xml(app.get(A + kind), paths, names):
            member = 'base/' + path if aab else path
            require(member in archive.namelist(), 'referenced backup XML missing')
            xml = (base.proto_xml if aab else base.binary_xml)(archive.read(member))
            variants.append({'path': member, **privacy_backup_policy(kind, xml)})
        output[kind] = variants
    return output


def verify_artifact(path, mode):
    result = {'path': str(path), 'status': 'failed', 'errors': []}
    try:
        result['sha256'] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            require(len(names) == len(set(names)), 'duplicate ZIP entries')
            aab = 'BundleConfig.pb' in names
            result['type'] = 'aab' if aab else 'apk'
            raw = archive.read('base/manifest/AndroidManifest.xml' if aab else 'AndroidManifest.xml')
            xml = (base.proto_xml if aab else base.binary_xml)(raw)
            result['privacy'] = verify_manifest(xml, mode)
            result['backup'] = verify_backup(xml, archive, aab)
    except base.InvalidArtifact as error:
        # Our validation errors contain fixed field names only, never values.
        result['errors'].append(str(error))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, struct.error, ET.ParseError,
            NotImplementedError, RuntimeError, EOFError):
        # Do not log raw metadata, endpoints, or parser bytes on malformed input.
        result['errors'].append('privacy manifest/backup validation failed')
    if not result['errors']:
        result['status'] = 'passed'
    return result


def verify_merged(build_dir, mode):
    paths = sorted({path for folder in ('merged_manifests', 'merged_manifest')
                    for path in (Path(build_dir) / 'intermediates' / folder).rglob('AndroidManifest.xml')
                    if any('release' in part.lower() for part in path.parts)})
    require(paths, 'no real merged release manifest was produced')
    output = []
    for path in paths:
        root = ET.parse(path).getroot()
        output.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                       **verify_manifest(root, mode, compiled=False)})
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', nargs='+', type=Path)
    parser.add_argument('--mode', choices=MODES, required=True)
    parser.add_argument('--build-dir', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(argv)
    reports = [verify_artifact(path, args.mode) for path in args.artifacts]
    payload = {'schema_version': 1, 'mode': args.mode, 'artifacts': reports,
               'limitations': ['Static packaging checks only; device/SDK behavior unverified.',
                               'Closed gates are required; a pass never enables release.']}
    try:
        require({report.get('type') for report in reports} == {'aab', 'apk'}, 'both AAB and APK are required')
        payload['merged_manifests'] = verify_merged(args.build_dir, args.mode)
    except (OSError, ValueError, ET.ParseError):
        payload['merged_manifest_error'] = 'missing, invalid, or unsafe merged release manifests/artifact pair'
    args.report.write_text(json.dumps(payload, indent=2) + '\n')
    for report in reports:
        print(f'{report["status"]}: privacy {report["path"]}')
    return int('merged_manifest_error' in payload or any(r['errors'] for r in reports))


if __name__ == '__main__':
    sys.exit(main())
