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
