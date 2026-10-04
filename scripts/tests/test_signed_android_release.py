import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

SCRIPT = Path(__file__).parents[1] / 'verify_signed_android_release.py'
spec = importlib.util.spec_from_file_location('signed_release', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
spec = importlib.util.spec_from_file_location('android_fixtures', Path(__file__).with_name('test_android_artifacts.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
CERTIFICATE = '12' * 32
OTHER_CERTIFICATE = '34' * 32
EXPECTED = dict(package='jp.yasagure.ponlet', version_name='1.0.18', version_code=2026093038,
                min_sdk=31, target_sdk=36, firebase_project='ponlet-599c4')
TOOLS = dict(jarsigner='jarsigner', keytool='keytool', apksigner='apksigner')


def proto_strings(project='ponlet-599c4', app_id='OPAQUE_ANDROID_ID_SENTINEL', crash_id='CRASH_BUILD_ID_SENTINEL',
                  app_alias=False):
    entries = []
    for index, (name, value) in enumerate(zip(m.FIREBASE_NAMES + ('google_api_key',),
                                            (app_id, project, crash_id, 'API_KEY_SENTINEL'))):
        item = f.pb(1, f.pb(2, 0x7f020001)) if app_alias and index == 0 else f.pb(2, f.pb(1, value))
        config = f.pb(6, f.pb(2, f.pb(4, item)))
        entries.append(f.pb(3, f.pb(1, f.pb(1, index)) + f.pb(2, name) + config))
    resource_type = f.pb(1, f.pb(1, 2)) + f.pb(2, 'string') + b''.join(entries)
    table = m.static.protobuf(f.proto_resources())
    package = m.static.field(table, 2, 2) + f.pb(3, resource_type)
    return f.pb(2, package)


def binary_table(project='ponlet-599c4', app_id='OPAQUE_ANDROID_ID_SENTINEL', crash_id='CRASH_BUILD_ID_SENTINEL',
                 flags=0, compact=False):
    strings = f.BACKUP_PATHS + [app_id, project, crash_id, 'API_KEY_SENTINEL']
    global_pool = f.string_pool(strings)
    keys = ['backup_rules', 'data_extraction_rules'] + list(m.FIREBASE_NAMES) + ['google_api_key']
    key_pool = f.string_pool(keys)
    def resource_type(type_id, start_key, count):
        entries, offsets = b'', []
        for index in range(count):
            key = start_key + index
            offsets.append(len(entries))
            if compact:
                entries += struct.pack('<HHI', key, 8 | 3 << 8, key)
            else:
                entries += struct.pack('<HHIHBBI', 8, 0, key, 8, 0, 3, key)
        if flags == 1:
            offset_table = b''.join(struct.pack('<HH', i, off // 4) for i, off in enumerate(offsets))
        elif flags == 2:
            offset_table = struct.pack('<' + 'H' * count, *[off // 4 for off in offsets])
        else:
            offset_table = struct.pack('<' + 'I' * count, *offsets)
        start = 24 + len(offset_table)
        return struct.pack('<HHIBBHIII', 0x201, 24, start + len(entries), type_id, flags, 0, count, start, 4) + offset_table + entries
    body = key_pool + resource_type(1, 0, 2) + resource_type(2, 2, 4)
    package = bytearray(288)
    struct.pack_into('<HHII', package, 0, 0x200, 288, 288 + len(body), 127)
    struct.pack_into('<I', package, 276, 288)
    table_body = global_pool + package + body
    return struct.pack('<HHII', 2, 12, 12 + len(table_body), 1) + table_body


def signature_output(arguments):
    if arguments[0] == 'jarsigner':
        return 'jar verified.\nWarning: self-signed certificate\nSIGNER_ALIAS_SENTINEL\n'
    if arguments[0] == 'keytool':
        colon = ':'.join(CERTIFICATE[i:i + 2] for i in range(0, len(CERTIFICATE), 2))
        return 'Signer #1:\nCertificate #1:\nOwner: CERT_SUBJECT_SENTINEL\n SHA256: ' + colon + '\n'
    if arguments[0] == 'apksigner':
        return 'Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ' + CERTIFICATE + '\nCERT_SUBJECT_SENTINEL\n'
    raise AssertionError('unexpected tool')


class SignedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def artifacts(self, signed=True, aab_resources=None, apk_resources=None, native_abi='arm64-v8a', **strings):
        aab, apk = self.root / 'release.aab', self.root / 'release.apk'
        with zipfile.ZipFile(aab, 'w') as z:
            z.writestr('BundleConfig.pb', f.pb(2, f.pb(2, f.pb(1, 1) + f.pb(2, 2))))
            z.writestr('base/manifest/AndroidManifest.xml', f.private_manifest())
            z.writestr('base/resources.pb', proto_strings(**strings) if aab_resources is None else aab_resources)
            z.writestr('base/' + f.BACKUP_PATHS[0], f.backup_xml('legacy'))
            z.writestr('base/' + f.BACKUP_PATHS[1], f.backup_xml('extraction'))
            z.writestr('base/lib/' + native_abi + '/libtest.so', f.elf())
            if signed:
                z.writestr('META-INF/SIGNER_ALIAS_SENTINEL.SF', b'fixture only; no real signature')
                z.writestr('META-INF/SIGNER_ALIAS_SENTINEL.RSA', b'fixture only; certificate verifier mocked')
        with zipfile.ZipFile(apk, 'w') as z:
            z.writestr('AndroidManifest.xml', f.binary_manifest(f.private_manifest()))
            z.writestr('resources.arsc', binary_table(**strings) if apk_resources is None else apk_resources)
            z.writestr(f.BACKUP_PATHS[0], f.binary_manifest(f.backup_xml('legacy')))
            z.writestr(f.BACKUP_PATHS[1], f.binary_manifest(f.backup_xml('extraction')))
            z.writestr('lib/' + native_abi + '/libtest.so', f.elf(), compress_type=zipfile.ZIP_DEFLATED)
        return aab, apk

    def test_full_valid_fixture_with_mocked_crypto_outputs_and_v2_only_apk(self):
        aab, apk = self.artifacts()
        with mock.patch.object(m, 'tool', side_effect=signature_output):
            report = m.verify_release(aab, apk, EXPECTED, TOOLS)
        self.assertTrue(report['verified'], report)
        self.assertTrue(report['certificates_match'])
        self.assertEqual(report['artifacts'][0]['signature']['certificate_sha256'], CERTIFICATE)
        self.assertEqual(report['artifacts'][1]['native_checks']['abis'], ['arm64-v8a'])
        self.assertTrue(all(all(r['firebase'].values()) for r in report['artifacts']))
        text = json.dumps(report)
        for sentinel in ('API_KEY_SENTINEL', 'OPAQUE_ANDROID_ID_SENTINEL', 'CRASH_BUILD_ID_SENTINEL',
                         'CERT_SUBJECT_SENTINEL', 'SIGNER_ALIAS_SENTINEL', 'FIREBASE_SENTINEL'):
            self.assertNotIn(sentinel, text)

    def test_apksigner_boolean_options_are_explicit(self):
        _, apk = self.artifacts()
        with mock.patch.object(m, 'tool', side_effect=signature_output) as tool:
            self.assertTrue(m.apk_signature(apk, 'apksigner')['verified'])
        tool.assert_called_once_with(['apksigner', 'verify', '--verbose', 'true', '--print-certs', 'true', str(apk)])

    def test_aab_unsigned_exit_zero_is_not_accepted(self):
        aab, _ = self.artifacts(signed=False)
        with mock.patch.object(m, 'tool', return_value='jar is unsigned.\n') as tool:
            with self.assertRaisesRegex(m.VerificationFailure, 'aab_signature_block_missing'):
                m.aab_signature(aab, 'jarsigner', 'keytool')
            tool.assert_not_called()
        aab, _ = self.artifacts()
        with mock.patch.object(m, 'tool', return_value='jar is unsigned.\n'):
            with self.assertRaisesRegex(m.VerificationFailure, 'aab_signature_not_verified'):
                m.aab_signature(aab, 'jarsigner', 'keytool')

    def test_verified_jar_with_unsigned_entries_fails(self):
        aab, _ = self.artifacts()
        with mock.patch.object(m, 'tool', return_value='jar verified.\nThis jar contains unsigned entries.\n'):
            with self.assertRaisesRegex(m.VerificationFailure, 'aab_unsigned_entries_present'):
                m.aab_signature(aab, 'jarsigner', 'keytool')

    def test_unsigned_warning_on_stderr_and_tampered_jar_fail_without_raw_output(self):
        aab, _ = self.artifacts()
        for result in (subprocess.CompletedProcess([], 0, stdout='jar verified.\n',
                                                   stderr='This jar contains unsigned entries. API_KEY_SENTINEL'),
                       subprocess.CompletedProcess([], 1, stdout='',
                                                   stderr='java.lang.SecurityException: digest mismatch API_KEY_SENTINEL')):
            with self.subTest(returncode=result.returncode), mock.patch.object(m.subprocess, 'run', return_value=result):
                report = m.artifact_summary(aab, 'aab', EXPECTED, TOOLS)
                self.assertFalse(report['verified'])
                self.assertNotIn('SENTINEL', json.dumps(report))
                self.assertIn(report['errors'][0], ('aab_unsigned_entries_present', 'signature_tool_failed'))

    def test_missing_malformed_or_multiple_signer_certificates_fail(self):
        aab, apk = self.artifacts()
        outputs = ['Verifies\nNumber of signers: 0\n',
                   'Verifies\nNumber of signers: 2\n',
                   'Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: 1234\n',
                   'Verifies\nNumber of signers: 1\n',
                   'DOES NOT VERIFY\n']
        for output in outputs:
            with self.subTest(output=output), mock.patch.object(m, 'tool', return_value=output):
                with self.assertRaises(m.VerificationFailure):
                    m.apk_signature(apk, 'apksigner')
        for keytool in ('Signer #1:\nSHA256: 1234\n', 'Signer #1:\n', 'Signer #1:\nSigner #2:\nSHA256: ' + CERTIFICATE):
            with mock.patch.object(m, 'tool', side_effect=['jar verified.\n', keytool]):
                with self.assertRaises(m.VerificationFailure):
                    m.aab_signature(aab, 'jarsigner', 'keytool')

    def test_apksigner_official_v31_sdk_range_labels_accept_only_one_public_certificate(self):
        _, apk = self.artifacts()
        header = 'Verifies\nVerified using v3.1 scheme (APK Signature Scheme v3.1): true\nNumber of signers: 1\n'
        def ranged(minimum, maximum, certificate=CERTIFICATE, dev=False):
            return ('Signer (minSdkVersion=' + str(minimum) + (' (dev release=true)' if dev else '') +
                    ', maxSdkVersion=' + str(maximum) + ') certificate SHA-256 digest: ' + certificate + '\n')
        for lines in (ranged(33, 2147483647),
                      ranged(33, 2147483647) + ranged(31, 32),
                      ranged(33, 2147483647, dev=True) + ranged(31, 32)):
            with self.subTest(lines=lines), mock.patch.object(m, 'tool', return_value=header + lines):
                result = m.apk_signature(apk, 'apksigner')
                self.assertEqual(result['certificate_sha256'], CERTIFICATE)
                self.assertEqual(result['signer_count'], 1)
        invalid = (ranged(33, 2147483647) + ranged(31, 32, OTHER_CERTIFICATE),
                   ranged(0, 32), ranged(33, 32), ranged(33, 2147483648),
                   ranged(33, 2147483647, '1234'),
                   ranged(33, 2147483647) + 'Signer #1 certificate SHA-256 digest: ' + CERTIFICATE + '\n',
                   ranged(33, 2147483647) + 'Signer UNKNOWN certificate SHA-256 digest: ' + CERTIFICATE + '\n',
                   ranged(33, 2147483647).replace('maxSdkVersion=', 'futureSdkVersion='))
        for lines in invalid:
            with self.subTest(lines=lines), mock.patch.object(m, 'tool', return_value=header + lines):
                with self.assertRaisesRegex(m.VerificationFailure, 'apk_public_certificate_missing_or_ambiguous'):
                    m.apk_signature(apk, 'apksigner')
        with mock.patch.object(m, 'tool', return_value=header.replace(': true', ': false') + ranged(33, 2147483647)):
            with self.assertRaises(m.VerificationFailure):
                m.apk_signature(apk, 'apksigner')

    def test_numbered_apk_duplicate_certificate_lines_fail_even_when_fingerprints_match(self):
        _, apk = self.artifacts()
        line = 'Signer #1 certificate SHA-256 digest: ' + CERTIFICATE + '\n'
        for extra in (line, line.replace('#1', '#2'), line.replace(CERTIFICATE, OTHER_CERTIFICATE)):
            with self.subTest(extra=extra), mock.patch.object(m, 'tool', return_value='Verifies\nNumber of signers: 1\n' + line + extra):
                with self.assertRaises(m.VerificationFailure):
                    m.apk_signature(apk, 'apksigner')

    def test_signature_failure_diagnostics_contain_only_capped_fixed_counts(self):
        _, apk = self.artifacts()
        header = 'Verifies\nNumber of signers: 1\n'
        unknown = 'Signer SIGNER_ALIAS_SENTINEL certificate SHA-256 digest: ' + CERTIFICATE + '\n'
        cases = [(unknown, dict(numbered_lines=0, sdk_range_lines=0, unknown_certificate_labels=1, unique_fingerprints=1)),
                 ('', dict(numbered_lines=0, sdk_range_lines=0, unknown_certificate_labels=0, unique_fingerprints=0)),
                 (unknown * 129, dict(numbered_lines=0, sdk_range_lines=0, unknown_certificate_labels=128, unique_fingerprints=1)),
                 ('Signer #1 certificate SHA-256 digest: ' + CERTIFICATE + '\n' +
                  'Signer #1 certificate SHA-256 digest: ' + OTHER_CERTIFICATE + '\n',
                  dict(numbered_lines=2, sdk_range_lines=0, unknown_certificate_labels=0, unique_fingerprints=2))]
        for lines, expected_counts in cases:
            expected_counts.update(certificate_digest_tokens=min(len(lines.splitlines()), 128),
                                   indented_certificate_lines=0, certificate_dn_lines=0,
                                   signer_label_lines=min(len(lines.splitlines()), 128),
                                   pem_certificate_blocks=0, v2_verified_lines=0,
                                   v3_verified_lines=0, v31_verified_lines=0)
            with self.subTest(expected_counts=expected_counts), mock.patch.object(m, 'tool', return_value=header + lines):
                report = m.artifact_summary(apk, 'apk', EXPECTED, TOOLS)
                self.assertFalse(report['verified'])
                self.assertEqual(report['signature_diagnostics'], expected_counts)
                self.assertEqual(set(report['signature_diagnostics']), set(m.SIGNATURE_DIAGNOSTIC_FIELDS))
                self.assertTrue(all(type(n) is int and 0 <= n <= 128 for n in report['signature_diagnostics'].values()))
                self.assertNotIn('SENTINEL', json.dumps(report))
                self.assertNotIn(CERTIFICATE, json.dumps(report))

    def test_missing_certificate_line_diagnostics_distinguish_missing_print_indentation_and_crlf(self):
        samples = [('Verifies\nNumber of signers: 1\n', {}),
                   ('  Signer #1 certificate SHA-256 digest: ' + CERTIFICATE + '\n',
                    dict(certificate_digest_tokens=1, indented_certificate_lines=1, signer_label_lines=1)),
                   ('Signer #1 certificate SHA-256 digest: ' + CERTIFICATE + '\r\n',
                    dict(certificate_digest_tokens=1, signer_label_lines=1)),
                   ('Signer #1 certificate DN: CERT_SUBJECT_SENTINEL\n'
                    'Signer #1 certificate SHA256 digest: OPAQUE_ANDROID_ID_SENTINEL\n',
                    dict(certificate_dn_lines=1, signer_label_lines=2)),
                   ('-----BEGIN CERTIFICATE-----\nCERT_SUBJECT_SENTINEL\n-----END CERTIFICATE-----\n'
                    'Verified using v3.1 scheme (APK Signature Scheme v3.1): true\n',
                    dict(pem_certificate_blocks=1, v31_verified_lines=1)),
                   ('Verified using v2 scheme (APK Signature Scheme v2): true\n'
                    'Verified using v3 scheme (APK Signature Scheme v3): true\n'
                    'Verified using v3.1 scheme (APK Signature Scheme v3.1): false\n',
                    dict(v2_verified_lines=1, v3_verified_lines=1))]
        for output, overrides in samples:
            with self.subTest(overrides=overrides), self.assertRaises(m.VerificationFailure) as error:
                m.apk_certificate_sha256(output)
            expected = dict.fromkeys(m.SIGNATURE_DIAGNOSTIC_FIELDS, 0)
            expected.update(overrides)
            self.assertEqual(error.exception.signature_diagnostics, expected)
            self.assertNotIn('SENTINEL', json.dumps(error.exception.signature_diagnostics))

    def test_official_sdk_range_fingerprint_still_matches_aab_public_certificate(self):
        aab, apk = self.artifacts()
        def output(arguments):
            if arguments[0] != 'apksigner':
                return signature_output(arguments)
            return ('Verifies\nNumber of signers: 1\n'
                    'Verified using v3.1 scheme (APK Signature Scheme v3.1): true\n'
                    'Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ' + CERTIFICATE + '\n'
                    'Signer (minSdkVersion=31, maxSdkVersion=32) certificate SHA-256 digest: ' + CERTIFICATE + '\n')
        with mock.patch.object(m, 'tool', side_effect=output):
            report = m.verify_release(aab, apk, EXPECTED, TOOLS)
        self.assertTrue(report['verified'])
        self.assertTrue(report['certificates_match'])
        self.assertNotIn('signature_diagnostics', report['artifacts'][1])

    def test_different_aab_and_apk_public_certificates_fail(self):
        aab, apk = self.artifacts()
        def output(args):
            text = signature_output(args)
            return text.replace(CERTIFICATE, OTHER_CERTIFICATE) if args[0] == 'apksigner' else text
        with mock.patch.object(m, 'tool', side_effect=output):
            report = m.verify_release(aab, apk, EXPECTED, TOOLS)
        self.assertFalse(report['verified'])
        self.assertEqual(report['errors'], ['aab_apk_public_certificates_differ'])

    def test_wrong_metadata_static_configuration_or_abi_never_reaches_signature_tools(self):
        aab, apk = self.artifacts()
        for key, wrong in [('package', 'wrong.package'), ('version_name', '0.0'), ('version_code', 1), ('min_sdk', 1), ('target_sdk', 35)]:
            with self.subTest(key=key), mock.patch.object(m, 'tool') as tool:
                report = m.verify_release(aab, apk, dict(EXPECTED, **{key: wrong}), TOOLS)
                self.assertFalse(report['verified'])
                tool.assert_not_called()
        with mock.patch.object(m.static, 'verify', return_value={'type':'aab', 'errors':['API_KEY_SENTINEL']}), mock.patch.object(m, 'tool') as tool:
            report = m.artifact_summary(aab, 'aab', EXPECTED, TOOLS)
            self.assertEqual(report['errors'], ['static_artifact_checks_failed'])
            tool.assert_not_called()
        for key, wrong in (('class', 32), ('machine', 62)):
            report = m.static.verify(aab)
            report['native_libraries'][0][key] = wrong
            with self.subTest(key=key), mock.patch.object(m.static, 'verify', return_value=report), mock.patch.object(m, 'tool') as tool:
                report = m.artifact_summary(aab, 'aab', EXPECTED, TOOLS)
                self.assertEqual(report['errors'], ['native_elf_not_aarch64'])
                tool.assert_not_called()
        aab, apk = self.artifacts(native_abi='x86_64')
        with mock.patch.object(m, 'tool') as tool:
            report = m.verify_release(aab, apk, EXPECTED, TOOLS)
        self.assertEqual([r['errors'] for r in report['artifacts']], [['native_abi_not_arm64_only']] * 2)
        tool.assert_not_called()

    def test_firebase_missing_blank_and_wrong_project_fail_without_values(self):
        for kwargs in ({'project':'wrong_project_SENSITIVE'}, {'app_id':''}, {'app_id':'  '}, {'crash_id':''}):
            aab, apk = self.artifacts(**kwargs)
            with self.subTest(kwargs=kwargs), mock.patch.object(m, 'tool') as tool:
                report = m.verify_release(aab, apk, EXPECTED, TOOLS)
                self.assertFalse(report['verified'])
                tool.assert_not_called()
                for value in kwargs.values():
                    if value.strip(): self.assertNotIn(value, json.dumps(report))
        aab, _ = self.artifacts(aab_resources=f.proto_resources())
        with mock.patch.object(m, 'tool') as tool:
            report = m.artifact_summary(aab, 'aab', EXPECTED, TOOLS)
        self.assertEqual(report['errors'], ['firebase_required_resource_missing_blank_or_unresolved'])
        tool.assert_not_called()

    def test_firebase_resource_aliases_fail_closed_without_values(self):
        # A protobuf Item holding a Reference rather than a String must not be
        # accepted as a nonblank Firebase value, even when its target exists.
        aliased_proto = proto_strings(app_alias=True)
        values = m.proto_firebase_values(aliased_proto)
        self.assertEqual(values['google_app_id'], {None})
        binary = bytearray(binary_table())
        # Locate the known noncompact String value for google_app_id, then make
        # it a Reference. This is a typed-value change, not a string replacement.
        original = struct.pack('<HHIHBBI', 8, 0, 2, 8, 0, 3, 2)
        aliased = struct.pack('<HHIHBBI', 8, 0, 2, 8, 0, 1, 0x7f020001)
        start = binary.index(original)
        binary[start:start + len(original)] = aliased
        self.assertEqual(m.binary_firebase_values(bytes(binary))['google_app_id'], {None})
        aab, apk = self.artifacts(aab_resources=aliased_proto, apk_resources=bytes(binary))
        with mock.patch.object(m, 'tool') as tool:
            report = m.verify_release(aab, apk, EXPECTED, TOOLS)
        self.assertFalse(report['verified'])
        self.assertEqual([r['errors'] for r in report['artifacts']],
                         [['firebase_required_resource_missing_blank_or_unresolved']] * 2)
        tool.assert_not_called()

    def test_binary_resources_sparse_offset16_and_compact_values(self):
        for flags in (0, 1, 2):
            for compact in (True, False):
                with self.subTest(flags=flags, compact=compact):
                    values = m.binary_firebase_values(binary_table(flags=flags, compact=compact))
                    self.assertEqual(values['project_id'], {'ponlet-599c4'})
                    self.assertEqual(set(values), set(m.FIREBASE_NAMES))
        with self.assertRaises((m.VerificationFailure, m.static.InvalidArtifact)):
            m.binary_firebase_values(binary_table()[:-1])

    def test_real_tool_wrapper_nonzero_timeout_and_exception_are_redacted(self):
        for effect in (subprocess.CompletedProcess([], 1, stdout='API_KEY_SENTINEL', stderr='SIGNER_ALIAS_SENTINEL'),
                       subprocess.TimeoutExpired('SIGNER_ALIAS_SENTINEL', 1, output='API_KEY_SENTINEL'),
                       OSError('API_KEY_SENTINEL')):
            patch = {'side_effect': effect} if isinstance(effect, Exception) else {'return_value': effect}
            with mock.patch.object(m.subprocess, 'run', **patch):
                with self.assertRaises(m.VerificationFailure) as error:
                    m.tool(['tool'])
                self.assertNotIn('SENTINEL', str(error.exception))
        with mock.patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='ok', stderr='')) as run:
            self.assertEqual(m.tool(['tool']), 'ok\n')
            self.assertTrue(run.call_args.kwargs['capture_output'])
            self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')

    def test_unexpected_decoder_exception_is_redacted(self):
        aab, _ = self.artifacts()
        with mock.patch.object(m.static, 'verify', side_effect=RuntimeError('API_KEY_SENTINEL')):
            report = m.artifact_summary(aab, 'aab', EXPECTED, TOOLS)
        self.assertEqual(report['errors'], ['artifact_validation_failed'])
        self.assertNotIn('SENTINEL', json.dumps(report))

    def test_cli_safe_json_success_failure_and_no_crypto_commands_other_than_verifiers(self):
        aab, apk = self.artifacts()
        report_path = self.root / 'safe.json'
        output = io.StringIO()
        with mock.patch.object(m, 'tool', side_effect=signature_output) as tool, contextlib.redirect_stdout(output):
            status = m.main([str(aab), str(apk), '--expect-version-code', str(EXPECTED['version_code']),
                             '--apksigner', 'apksigner', '--report', str(report_path)])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue()), json.loads(report_path.read_text()))
        for call in tool.call_args_list:
            args = call.args[0]
            self.assertNotIn('-sign', args)
            self.assertNotIn('-keystore', args)
        self.assertNotIn('SENTINEL', output.getvalue())
        output = io.StringIO()
        with mock.patch.object(m, 'tool', return_value='jar is unsigned.\n'), contextlib.redirect_stdout(output):
            status = m.main([str(aab), str(apk), '--expect-version-code', str(EXPECTED['version_code']), '--apksigner','apksigner'])
        self.assertEqual(status, 1)
        self.assertFalse(json.loads(output.getvalue())['verified'])


if __name__ == '__main__':
    unittest.main()
