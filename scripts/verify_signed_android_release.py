#!/usr/bin/env python3
"""Verify signed Android release artifacts and emit only a safe JSON summary.

No signing, authentication, publishing or upload operations are performed. Tool
output and Firebase resource values stay internal and are never reported. APK
signatures are checked with apksigner (v2/v3 signatures need not contain a JAR
signature); the AAB JAR signature is checked with jarsigner and keytool.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

_spec = importlib.util.spec_from_file_location('android_static_checks', Path(__file__).with_name('verify_android_artifacts.py'))
static = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(static)
FIREBASE_NAMES = ('google_app_id', 'project_id', 'com.google.firebase.crashlytics.mapping_file_id')
SIGNATURE_DIAGNOSTIC_FIELDS = ('numbered_lines', 'sdk_range_lines', 'unknown_certificate_labels', 'unique_fingerprints',
                             'certificate_digest_tokens', 'indented_certificate_lines', 'certificate_dn_lines',
                             'signer_label_lines', 'pem_certificate_blocks', 'v2_verified_lines',
                             'v3_verified_lines', 'v31_verified_lines')


class VerificationFailure(ValueError):
    """Codes are controlled strings; never embed tool output or configuration."""
    pass


def check(condition, code):
    if not condition:
        raise VerificationFailure(code)


def tool(arguments):
    environment = os.environ.copy()
    environment['LC_ALL'] = 'C'
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, env=environment, timeout=120)
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise VerificationFailure('signature_tool_unavailable_or_timed_out')
    check(result.returncode == 0, 'signature_tool_failed')
    # Both streams remain internal: jarsigner may emit unsigned-entry warnings
    # on stderr while exiting zero and printing the verified marker on stdout.
    return result.stdout + '\n' + result.stderr


def fingerprint(value):
    result = value.replace(':', '').lower()
    check(bool(re.fullmatch('[0-9a-f]{64}', result)), 'invalid_public_certificate_fingerprint')
    return result


def aab_signature(path, jarsigner, keytool):
    with zipfile.ZipFile(path) as archive:
        names = {name.upper() for name in archive.namelist()}
    signatures = [name[:-3] for name in names if re.fullmatch(r'META-INF/[^/]+\.SF', name)]
    check(any(stem + extension in names for stem in signatures for extension in ('.RSA', '.DSA', '.EC')),
          'aab_signature_block_missing')
    verified = tool([jarsigner, '-J-Duser.language=en', '-J-Duser.country=US', '-verify', str(path)])
    # jarsigner exits zero for an unsigned JAR, so the verified marker is required.
    check(bool(re.search(r'(?m)^jar verified\.$', verified)), 'aab_signature_not_verified')
    check(not re.search(r'unsigned entries|jar is unsigned', verified, re.I), 'aab_unsigned_entries_present')
    certificate = tool([keytool, '-J-Duser.language=en', '-J-Duser.country=US', '-printcert', '-jarfile', str(path)])
    check(re.findall(r'(?m)^Signer #(\d+):', certificate) == ['1'], 'aab_signer_count_not_one')
    values = re.findall(r'(?m)^\s*SHA256:\s*([0-9a-fA-F:]+)\s*$', certificate)
    check(bool(values), 'aab_public_certificate_missing')
    return {'verified': True, 'signature_present': True, 'signer_count': 1,
            'certificate_sha256': fingerprint(values[0])}


def apk_signature(path, apksigner):
    output = tool([apksigner, 'verify', '--verbose', 'true', '--print-certs', 'true', str(path)])
    check(bool(re.search(r'(?m)^Verifies\s*$', output)), 'apk_signature_not_verified')
    check(re.findall(r'(?m)^Number of signers:\s*(\d+)\s*$', output) == ['1'], 'apk_signer_count_not_one')
    return {'verified': True, 'signature_present': True, 'signer_count': 1,
            'certificate_sha256': apk_certificate_sha256(output)}


def apk_certificate_sha256(output):
    # ApkSignerTool prints SDK-range labels for v3.1 and numbered labels for
    # earlier schemes. Inspect every signer certificate line, including unknown
    # labels, so no additional or malformed certificate can silently be ignored.
    # https://android.googlesource.com/platform/tools/apksig/+/refs/heads/main/src/apksigner/java/com/android/apksigner/ApkSignerTool.java
    lines = re.findall(r'(?m)^Signer[^\r\n]* certificate SHA-256 digest:[^\r\n]*$', output)
    numbered = r'Signer #\d+'
    sdk_range = r'Signer \(minSdkVersion=\d+(?: \(dev release=true\))?, maxSdkVersion=\d+\)'
    counts = dict.fromkeys(SIGNATURE_DIAGNOSTIC_FIELDS, 0)
    # These bounded counts distinguish missing certificate printing from label,
    # indentation or line-ending differences without releasing any tool text.
    counts['certificate_digest_tokens'] = output.count('certificate SHA-256 digest:')
    counts['indented_certificate_lines'] = len(re.findall(r'(?m)^[ \t]+Signer[^\r\n]* certificate SHA-256 digest:', output))
    counts['certificate_dn_lines'] = output.count(' certificate DN:')
    counts['signer_label_lines'] = len(re.findall(r'(?m)^[ \t]*Signer\b', output))
    counts['pem_certificate_blocks'] = output.count('-----BEGIN CERTIFICATE-----')
    counts['v2_verified_lines'] = len(re.findall(r'(?m)^Verified using v2 scheme \(APK Signature Scheme v2\): true\s*$', output))
    counts['v3_verified_lines'] = len(re.findall(r'(?m)^Verified using v3 scheme \(APK Signature Scheme v3\): true\s*$', output))
    counts['v31_verified_lines'] = len(re.findall(r'(?m)^Verified using v3\.1 scheme \(APK Signature Scheme v3\.1\): true\s*$', output))
    recognized_fingerprints = set()
    for line in lines:
        label, digest = line.split(' certificate SHA-256 digest:', 1)
        key = ('numbered_lines' if re.fullmatch(numbered, label) else
               'sdk_range_lines' if re.fullmatch(sdk_range, label) else 'unknown_certificate_labels')
        counts[key] += 1
        if re.fullmatch('[0-9a-fA-F]{64}', digest.strip()):
            recognized_fingerprints.add(digest.strip().lower())
    counts['unique_fingerprints'] = len(recognized_fingerprints)
    counts = {key: min(value, 128) for key, value in counts.items()}
    try:
        check(bool(lines), 'apk_public_certificate_missing_or_ambiguous')
        certificates, modes = set(), set()
        for line in lines:
            match = re.fullmatch(r'Signer (?P<label>#\d+|\(minSdkVersion=\d+(?: \(dev release=true\))?, maxSdkVersion=\d+\))'
                                 r' certificate SHA-256 digest:\s*(?P<digest>[0-9a-fA-F]{64})\s*', line)
            check(match is not None, 'apk_public_certificate_missing_or_ambiguous')
            label = match['label']
            if label.startswith('#'):
                check(label == '#1', 'apk_public_certificate_missing_or_ambiguous')
                modes.add('numbered')
            else:
                minimum, maximum = (int(n) for n in re.findall(r'SdkVersion=(\d+)', label))
                check(1 <= minimum <= maximum <= 2147483647, 'apk_public_certificate_missing_or_ambiguous')
                modes.add('sdk_range')
            certificates.add(fingerprint(match['digest']))
        check(len(certificates) == 1 and len(modes) == 1, 'apk_public_certificate_missing_or_ambiguous')
        if modes == {'numbered'}:
            check(len(lines) == 1, 'apk_public_certificate_missing_or_ambiguous')
        else:
            check(bool(re.search(r'(?m)^Verified using v3\.1 scheme \(APK Signature Scheme v3\.1\): true\s*$', output)),
                  'apk_public_certificate_missing_or_ambiguous')
        return next(iter(certificates))
    except VerificationFailure as error:
        error.signature_diagnostics = counts
        raise


def proto_firebase_values(data):
    values = {name: set() for name in FIREBASE_NAMES}
    for package in static.repeated_messages(static.protobuf(data), 2):
        for resource_type in static.repeated_messages(package, 3):
            if static.string(resource_type, 2) != 'string':
                continue
            for entry in static.repeated_messages(resource_type, 3):
                name = static.string(entry, 2)
                if name not in values:
                    continue
                for config in static.repeated_messages(entry, 6):
                    value = static.protobuf(static.field(config, 2, 2, b''))
                    item = static.protobuf(static.field(value, 4, 2, b''))
                    text = static.protobuf(static.field(item, 2, 2, b''))
                    raw = static.field(text, 1, 2)
                    values[name].add(raw.decode('utf-8') if raw is not None else None)
    return values


def binary_firebase_values(data):
    """Decode only the three named string resources; never return other values."""
    kind, header, total = static.unpack('<HHI', data, 0)
    check(kind == 2 and header >= 12 and total == len(data), 'invalid_compiled_resource_table')
    package_count = static.unpack('<I', data, 8)[0]
    strings, packages = None, []
    for kind, subheader, chunk in static.binary_chunks(data, header, total):
        if kind == 1:
            check(strings is None, 'invalid_compiled_resource_table')
            strings = static.binary_strings(chunk)
        elif kind == 0x200:
            packages.append((subheader, chunk))
    check(strings is not None and len(packages) == package_count, 'invalid_compiled_resource_table')
    values = {name: set() for name in FIREBASE_NAMES}
    for package_header, package in packages:
        check(package_header >= 284, 'unsupported_compiled_resource_table')
        key_offset = static.unpack('<I', package, 276)[0]
        check(package_header <= key_offset < len(package), 'invalid_resource_key_pool')
        key_kind, key_header, key_size = static.unpack('<HHI', package, key_offset)
        check(key_kind == 1 and key_header >= 28 and key_offset + key_size <= len(package), 'invalid_resource_key_pool')
        keys = static.binary_strings(package[key_offset:key_offset + key_size])
        for kind, type_header, chunk in static.binary_chunks(package, package_header, len(package)):
            if kind != 0x201:
                continue
            check(type_header >= 24, 'invalid_resource_type')
            type_id, flags, reserved, count, entry_start = static.unpack('<BBHII', chunk, 8)
            check(type_id and reserved == 0 and flags in (0, 1, 2), 'unsupported_resource_type')
            config_size = static.unpack('<I', chunk, 20)[0]
            check(config_size >= 4 and 20 + config_size <= type_header, 'invalid_resource_configuration')
            offset_size = 2 if flags == 2 else 4
            check(type_header + count * offset_size <= entry_start <= len(chunk), 'invalid_resource_offsets')
            for index in range(count):
                if flags == 1:
                    _, offset = static.unpack('<HH', chunk, type_header + index * 4)
                    offset *= 4
                elif flags == 2:
                    short = static.unpack('<H', chunk, type_header + index * 2)[0]
                    offset = short * 4 if short != 0xFFFF else 0xFFFFFFFF
                else:
                    offset = static.unpack('<I', chunk, type_header + index * 4)[0]
                if offset == 0xFFFFFFFF:
                    continue
                start = entry_start + offset
                first, entry_flags, third = static.unpack('<HHI', chunk, start)
                key_index = first if entry_flags & 8 else third
                check(key_index < len(keys), 'invalid_resource_key_index')
                name = keys[key_index]
                if name not in values:
                    continue
                if entry_flags & 1:
                    values[name].add(None)
                    continue
                if entry_flags & 8:
                    value_type, value = entry_flags >> 8, third
                else:
                    check(first >= 8, 'invalid_resource_entry')
                    value_size, zero, value_type, value = static.unpack('<HBBI', chunk, start + first)
                    check(value_size == 8 and zero == 0, 'invalid_resource_value')
                if value_type == 3:
                    check(value < len(strings), 'invalid_resource_string_index')
                    values[name].add(strings[value])
                else:
                    values[name].add(None)
    return values


def firebase_summary(path, kind, expected_project):
    member = 'base/resources.pb' if kind == 'aab' else 'resources.arsc'
    with zipfile.ZipFile(path) as archive:
        check(member in archive.namelist(), 'firebase_compiled_resource_table_missing')
        try:
            values = (proto_firebase_values if kind == 'aab' else binary_firebase_values)(archive.read(member))
        except (VerificationFailure, static.InvalidArtifact, UnicodeError, KeyError, ValueError):
            raise VerificationFailure('firebase_compiled_resource_decode_failed')
    check(all(values[name] and all(isinstance(v, str) and v.strip() for v in values[name]) for name in FIREBASE_NAMES),
          'firebase_required_resource_missing_blank_or_unresolved')
    check(values['project_id'] == {expected_project}, 'firebase_project_does_not_match')
    return {'google_app_id_present': True, 'project_matches_expected': True,
            'crashlytics_build_id_present': True}


def native_summary(path, report):
    values = []
    with zipfile.ZipFile(path) as archive:
        for library in report['native_libraries']:
            match = re.fullmatch(r'(?:[^/]+/)?lib/([^/]+)/([^/]+\.so)', library['path'])
            check(match is not None, 'unknown_native_library_layout')
            check(library['class'] == 64 and library['machine'] == 183, 'native_elf_not_aarch64')
            values.append({'name': match[2], 'abi': match[1],
                           'elf_class': library['class'], 'elf_machine': library['machine'],
                           'sha256': hashlib.sha256(archive.read(library['path'])).hexdigest(),
                           'load_16k': all(s['aligned_16k'] and s['congruent_16k'] for s in library['loads']),
                           'relro_guide_warning_count': sum(bool(s['end_mod_16k']) for s in library['relro'])})
    check({v['abi'] for v in values} == {'arm64-v8a'}, 'native_abi_not_arm64_only')
    return {'count': len(values), 'abis': ['arm64-v8a'], 'all_loads_16k': all(v['load_16k'] for v in values),
            'relro_guide_warning_count': sum(v['relro_guide_warning_count'] for v in values), 'libraries': values}


def artifact_summary(path, kind, expected, tools):
    report = {'type': kind, 'verified': False, 'errors': []}
    try:
        check(Path(path).suffix.lower() == '.' + kind, 'wrong_artifact_extension')
        report['sha256'] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        checked = static.verify(path, require_camera_optional=True, expect_version_code=expected['version_code'],
                                require_no_ad_id=True, require_received_cloud_excluded=True)
        check(checked.get('type') == kind and not checked['errors'], 'static_artifact_checks_failed')
        manifest = checked['manifest']
        for key in ('package', 'version_name', 'version_code', 'min_sdk', 'target_sdk'):
            check(manifest[key] == expected[key], 'release_metadata_does_not_match')
        report['manifest'] = {key: manifest[key] for key in ('package', 'version_name', 'version_code', 'min_sdk', 'target_sdk')}
        report['static_checks'] = {'camera_optional': True, 'no_ad_id': True, 'received_cloud_excluded': True,
                                   'bundle_requests_16k': checked.get('bundle_page_alignment') == 'PAGE_ALIGNMENT_16K' if kind == 'aab' else None,
                                   'apk_native_zip_16k': True if kind == 'apk' else None}
        report['native_checks'] = native_summary(path, checked)
        report['firebase'] = firebase_summary(path, kind, expected['firebase_project'])
        report['signature'] = (aab_signature(path, tools['jarsigner'], tools['keytool']) if kind == 'aab'
                               else apk_signature(path, tools['apksigner']))
        report['verified'] = True
    except VerificationFailure as error:
        report['errors'].append(str(error))
        if hasattr(error, 'signature_diagnostics'):
            report['signature_diagnostics'] = error.signature_diagnostics
    except Exception:
        # Third-party tool/decoder exceptions may contain paths, values or bytes.
        report['errors'].append('artifact_validation_failed')
    return report


def verify_release(aab, apk, expected, tools):
    artifacts = [artifact_summary(aab, 'aab', expected, tools), artifact_summary(apk, 'apk', expected, tools)]
    certificates_match = (all(r['verified'] for r in artifacts) and
                          artifacts[0]['signature']['certificate_sha256'] == artifacts[1]['signature']['certificate_sha256'])
    errors = []
    if all(r['verified'] for r in artifacts) and not certificates_match:
        errors.append('aab_apk_public_certificates_differ')
    return {'schema_version': 1, 'verified': all(r['verified'] for r in artifacts) and certificates_match,
            'certificates_match': certificates_match, 'errors': errors, 'artifacts': artifacts,
            'limitations': ['Static configuration and cryptographic signature verification only.',
                            'No app installation, Firebase communication, backup/restore or store submission was tested.',
                            'RELRO guide warnings are retained separately and do not assert runtime failure.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('aab', type=Path)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--expect-version-code', type=int, required=True)
    parser.add_argument('--expect-version-name', default='1.0.18')
    parser.add_argument('--expect-package', default='jp.yasagure.ponlet')
    parser.add_argument('--expect-min-sdk', type=int, default=31)
    parser.add_argument('--expect-target-sdk', type=int, default=36)
    parser.add_argument('--expect-firebase-project', default='ponlet-599c4')
    parser.add_argument('--jarsigner', default='jarsigner')
    parser.add_argument('--keytool', default='keytool')
    parser.add_argument('--apksigner', required=True)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.expect_version_code <= 2100000000:
        parser.error('--expect-version-code must be in 1..2100000000')
    expected = {'package': args.expect_package, 'version_name': args.expect_version_name,
                'version_code': args.expect_version_code, 'min_sdk': args.expect_min_sdk,
                'target_sdk': args.expect_target_sdk, 'firebase_project': args.expect_firebase_project}
    tools = {name: getattr(args, name) for name in ('jarsigner', 'keytool', 'apksigner')}
    report = verify_release(args.aab, args.apk, expected, tools)
    rendered = json.dumps(report, indent=2) + '\n'
    if args.report:
        try:
            args.report.write_text(rendered, encoding='utf-8')
        except OSError:
            print(json.dumps({'verified': False, 'errors': ['safe_report_write_failed']}))
            return 1
    print(rendered, end='')
    return 0 if report['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
