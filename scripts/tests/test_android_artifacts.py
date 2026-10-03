import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).parents[1] / 'verify_android_artifacts.py'
spec = importlib.util.spec_from_file_location('android_artifacts', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def vint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def pb(key, value):
    if isinstance(value, str):
        value = value.encode()
    if isinstance(value, bytes):
        return vint(key << 3 | 2) + vint(len(value)) + value
    return vint(key << 3) + vint(value)


def node(name, attributes=(), children=()):
    element = pb(3, name)
    for key, value in attributes:
        attr = pb(2, key) + pb(3, value)
        if key != 'package':
            attr += pb(1, m.ANDROID)
        element += pb(4, attr)
    for child in children:
        element += pb(5, child)
    return pb(1, element)


def manifest(camera_required=False, camera_permission=True, missing_implied=False):
    children = [node('uses-sdk', [('minSdkVersion', '31'), ('targetSdkVersion', '36')])]
    if camera_permission:
        children.append(node('uses-permission', [('name', 'android.permission.CAMERA')]))
    for feature in ('camera.any',) if missing_implied else ('camera', 'camera.autofocus', 'camera.any'):
        children.append(node('uses-feature', [('name', 'android.hardware.' + feature),
                                             ('required', 'true' if camera_required else 'false')]))
    # Metadata values must not escape into the report.
    children.append(node('application', children=[node('meta-data', [('name', 'secret'), ('value', 'FIREBASE_SENTINEL')])]))
    return node('manifest', [('package', 'jp.yasagure.ponlet'), ('versionCode', '2026093038'), ('versionName', '1.0.18')], children)


def elf(align=16384, congruent=True, relro_end=16384, writable_tail=False, bits=64, endian='<'):
    cls = 2 if bits == 64 else 1
    ehsize, phsize = (64, 56) if cls == 2 else (52, 32)
    count = 3
    data = bytearray(32768)
    data[:16] = b'\x7fELF' + bytes([cls, 1 if endian == '<' else 2, 1]) + bytes(9)
    struct.pack_into(endian + ('HHIQQQIHHHHHH' if cls == 2 else 'HHIIIIIHHHHHH'), data, 16,
                     3, 183 if cls == 2 else 40, 1, 0, ehsize, 0, 0, ehsize, phsize, count, 0, 0, 0)
    # Second LOAD starts after RELRO except when testing the rounded writable tail.
    writable_addr = relro_end if writable_tail else 16384
    segments = [(1, 4, 0, 0, 4096, 4096, align),
                (1, 6, writable_addr if congruent else writable_addr + 1, writable_addr, 4096, 4096, align),
                (m.PT_GNU_RELRO, 4, 4096, 4096, 0, relro_end - 4096, 1)]
    for index, (kind, flags, offset, addr, filesz, memsz, alignment) in enumerate(segments):
        values = (kind, flags, offset, addr, 0, filesz, memsz, alignment) if cls == 2 else (kind, offset, addr, 0, filesz, memsz, flags, alignment)
        struct.pack_into(endian + ('IIQQQQQQ' if cls == 2 else 'IIIIIIII'), data, ehsize + index * phsize, *values)
    return bytes(data)


def binary_manifest(proto):
    """Encode the fixture into Android binary XML including typed bool/int values."""
    root = m.proto_xml(proto)
    strings = [m.ANDROID]
    def add(value):
        if value not in strings:
            strings.append(value)
        return strings.index(value)
    for element in root.iter():
        add(element.tag)
        for key, value in element.attrib.items():
            add(key.split('}')[-1]); add(value)
    encoded = []
    offsets = []
    for value in strings:
        raw = value.encode()
        # Fixtures fit short UTF-8 pool lengths.
        offsets.append(sum(map(len, encoded)))
        encoded.append(bytes([len(value), len(raw)]) + raw + b'\0')
    pool_data = b''.join(encoded)
    pool_data += b'\0' * (-len(pool_data) % 4)
    pool_size = 28 + len(strings) * 4 + len(pool_data)
    pool = struct.pack('<HHIIIIII', 1, 28, pool_size, len(strings), 0, 0x100, 28 + len(strings) * 4, 0)
    pool += struct.pack('<' + 'I' * len(strings), *offsets) + pool_data
    def element_bytes(element):
        attrs = b''
        for key, value in element.attrib.items():
            namespace = 0 if key.startswith('{') else 0xFFFFFFFF
            key = key.split('}')[-1]
            if value in ('true', 'false'):
                raw, kind, data = 0xFFFFFFFF, 0x12, int(value == 'true')
            elif value.isdecimal():
                raw, kind, data = 0xFFFFFFFF, 0x10, int(value)
            else:
                raw, kind, data = add(value), 3, add(value)
            attrs += struct.pack('<IIIHBBI', namespace, add(key), raw, 8, 0, kind, data)
        body = struct.pack('<IIHHHHHH', 0xFFFFFFFF, add(element.tag), 20, 20, len(element.attrib), 0, 0, 0) + attrs
        start = struct.pack('<HHIII', 0x102, 16, 16 + len(body), 1, 0xFFFFFFFF) + body
        end = struct.pack('<HHIIIII', 0x103, 16, 24, 1, 0xFFFFFFFF, 0xFFFFFFFF, add(element.tag))
        return start + b''.join(element_bytes(child) for child in element) + end
    body = pool + element_bytes(root)
    return struct.pack('<HHI', 3, 8, 8 + len(body)) + body


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def aab(self, native=None, xml=None, alignment=2, config=None):
        path = self.root / 'app.aab'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('BundleConfig.pb', pb(2, pb(2, pb(1, 1) + pb(2, alignment))) if config is None else config)
            z.writestr('base/manifest/AndroidManifest.xml', manifest() if xml is None else xml)
            if native is not False:
                z.writestr('base/lib/arm64-v8a/libtest.so', elf() if native is None else native)
        return path

    def apk(self, aligned=True, compressed=False):
        path = self.root / 'app.apk'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('AndroidManifest.xml', binary_manifest(manifest()), compress_type=zipfile.ZIP_DEFLATED)
            info = zipfile.ZipInfo('lib/arm64-v8a/libtest.so')
            info.compress_type = zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED
            if aligned:
                pad = -(z.fp.tell() + 30 + len(info.filename.encode()) + 4) % 16384
                info.extra = struct.pack('<HH', 0xCAFE, pad) + bytes(pad)
            z.writestr(info, elf())
        return path

    def test_valid_aab_preserves_only_safe_manifest_summary(self):
        report = m.verify(self.aab(), True, 2026093038, True)
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['manifest']['target_sdk'], 36)
        self.assertEqual(report['bundle_page_alignment'], 'PAGE_ALIGNMENT_16K')
        self.assertNotIn('FIREBASE_SENTINEL', json.dumps(report))
        self.assertEqual(len(report['native_libraries'][0]['loads']), 2)

    def test_old_alignment_camera_required_and_version_are_rejected(self):
        report = m.verify(self.aab(elf(4096), manifest(True)), True, 2026093039)
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(any('LOAD' in e for e in report['errors']))
        self.assertTrue(any('camera hardware' in e for e in report['errors']))
        self.assertTrue(any('versionCode' in e for e in report['errors']))

    def test_camera_permission_implies_features_without_explicit_optional(self):
        report = m.verify(self.aab(xml=manifest(missing_implied=True)), True)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['manifest']['camera_implied_required'],
                         ['android.hardware.camera', 'android.hardware.camera.autofocus'])

    def test_no_camera_permission_needs_no_optional_declarations(self):
        xml = node('manifest', [('package', 'test.app'), ('versionCode', '1'), ('versionName', '1')],
                   [node('uses-sdk', [('minSdkVersion', '31'), ('targetSdkVersion', '36')])])
        self.assertEqual(m.verify(self.aab(xml=xml), True)['status'], 'passed')

    def test_congruence_rejected_even_with_large_alignment(self):
        self.assertEqual(m.verify(self.aab(elf(congruent=False)))['status'], 'failed')

    def test_relro_warning_is_distinct_from_load_and_strict_mode(self):
        artifact = self.aab(elf(relro_end=8192))
        report = m.verify(artifact)
        self.assertEqual(report['status'], 'passed_with_warnings')
        self.assertFalse(report['errors'])
        self.assertEqual(report['native_libraries'][0]['relro'][0]['writable_loads_in_rounded_tail'], [])
        self.assertEqual(m.verify(artifact, strict_relro=True)['status'], 'failed')

    def test_relro_rounded_tail_overlap_is_recorded(self):
        report = m.verify(self.aab(elf(relro_end=8192, writable_tail=True)))
        self.assertEqual(report['native_libraries'][0]['relro'][0]['writable_loads_in_rounded_tail'], [1])
        self.assertEqual(report['status'], 'passed_with_warnings')

    def test_bundle_config_unknown_missing_and_4k_rejected(self):
        for kwargs in ({'alignment': 1}, {'alignment': 0}, {'alignment': 9}, {'config': b'\x12\xff'}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(m.verify(self.aab(**kwargs))['status'], 'failed')

    def test_corrupt_and_unknown_inputs_never_pass(self):
        for kwargs in ({'native': b'not ELF'}, {'native': elf()[:80]}, {'native': False}, {'xml': b'bad'}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(m.verify(self.aab(**kwargs))['status'], 'failed')
        path = self.root / 'bad.aab'; path.write_bytes(b'not ZIP')
        self.assertEqual(m.verify(path)['status'], 'failed')
        self.assertEqual(m.verify(self.root / 'missing.aab')['status'], 'failed')

    def test_duplicate_zip_entries_are_rejected(self):
        path = self.aab()
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with zipfile.ZipFile(path, 'a') as z:
                z.writestr('BundleConfig.pb', b'')
        self.assertEqual(m.verify(path)['status'], 'failed')

    def test_elf32_and_big_endian_are_parsed(self):
        for bits in (32, 64):
            for endian in ('<', '>'):
                with self.subTest(bits=bits, endian=endian):
                    report = m.elf_summary(elf(bits=bits, endian=endian))
                    self.assertTrue(all(l['aligned_16k'] for l in report['loads']))
                    self.assertEqual(report['class'], bits)

    def test_apk_binary_manifest_and_zip_alignment(self):
        report = m.verify(self.apk(), True, 2026093038, True)
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['type'], 'apk')
        self.assertEqual(report['manifest']['package'], 'jp.yasagure.ponlet')
        self.assertEqual(report['native_libraries'][0]['zip_data_offset'] % 16384, 0)
        self.assertEqual(m.verify(self.apk(aligned=False))['status'], 'failed')
        self.assertEqual(m.verify(self.apk(aligned=False, compressed=True))['status'], 'passed')

    def test_binary_xml_truncation_and_missing_sdk_rejected(self):
        with self.assertRaises(m.InvalidArtifact):
            m.binary_xml(binary_manifest(manifest())[:-1])
        xml = node('manifest', [('package', 'test.app'), ('versionCode', '1'), ('versionName', '1')])
        self.assertEqual(m.verify(self.aab(xml=xml))['status'], 'failed')

    def test_protobuf_scalar_duplicate_and_wrong_wire_rejected(self):
        for data in (b'\0', pb(1, 1) + pb(1, 2), pb(1, b'text')):
            with self.subTest(data=data), self.assertRaises(m.InvalidArtifact):
                m.field(m.protobuf(data), 1, 0)

    def test_compiled_proto_value_is_authoritative_and_unknown_not_false(self):
        attr = m.protobuf(pb(2, 'required') + pb(3, 'false') + pb(6, pb(7, pb(8, 1))))
        self.assertEqual(m.proto_value(attr), 'true')
        self.assertEqual(m.proto_value(m.protobuf(pb(6, pb(7, pb(8, 0))))), 'false')
        self.assertEqual(m.proto_value(m.protobuf(pb(3, 'false') + pb(6, pb(1, pb(2, 123))))), '@unresolved')

    def test_relro_absence_and_non_power_of_two_alignment(self):
        native = bytearray(elf())
        struct.pack_into('<I', native, 64 + 2 * 56, 0)
        self.assertEqual(m.verify(self.aab(bytes(native)), strict_relro=True)['status'], 'passed')
        self.assertEqual(m.verify(self.aab(elf(align=24576)))['status'], 'failed')

    def test_invalid_version_and_unknown_permission_fail(self):
        for xml in (manifest().replace(b'2026093038', b'9999999999'),
                    manifest().replace(b'android.permission.CAMERA', b'@unresolved_permissionxx')):
            self.assertEqual(m.verify(self.aab(xml=xml))['status'], 'failed')

    def test_cli_multi_artifact_report_and_exit_status(self):
        good = self.aab()
        bad = self.root / 'bad.apk'; bad.write_bytes(b'bad')
        report = self.root / 'report.json'
        process = subprocess.run([sys.executable, str(SCRIPT), str(good), str(bad), '--report', str(report),
                                  '--require-camera-optional', '--strict-relro'], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        payload = json.loads(report.read_text())
        self.assertEqual([r['status'] for r in payload['artifacts']], ['passed', 'failed'])
        self.assertNotIn('FIREBASE_SENTINEL', process.stdout + report.read_text())


if __name__ == '__main__':
    unittest.main()
