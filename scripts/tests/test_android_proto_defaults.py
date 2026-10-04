"""AOSP Resources.proto attribute defaults, including canonical proto3 bytes.

The fixtures model the published wire format; they are not real build output.
Sources: tools/aapt2/Resources.proto (XmlAttribute and Item), and
https://protobuf.dev/programming-guides/proto3/#default .
"""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import verify_android_artifacts as base
import verify_android_privacy as privacy

spec = importlib.util.spec_from_file_location('privacy_default_fixtures', SCRIPTS / 'tests/test_android_privacy.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
pb = fixtures.fixtures.pb


def omit_empty_attribute_values(xml):
    """Canonicalize only XmlAttribute.value, preserving attribute presence."""
    def encode(fields):
        return b''.join(pb(number, value) for number, items in fields.items() for _, value in items)
    node = base.protobuf(xml)
    if 1 not in node:
        return xml
    element = base.protobuf(base.field(node, 1, 2))
    attrs = []
    for wire, raw in element.get(4, []):
        attr = base.protobuf(raw)
        if base.field(attr, 3, 2) == b'':
            del attr[3]
        attrs.append((wire, encode(attr)))
    element[4] = attrs
    element[5] = [(wire, omit_empty_attribute_values(raw)) for wire, raw in element.get(5, [])]
    node[1] = [(2, encode(element))]
    return encode(node)


class ProtoAttributeDefaultTests(unittest.TestCase):
    def value(self, extra=b''):
        # XmlAttribute name="value" with value/compiled_item supplied by caller.
        return base.proto_value(base.protobuf(bytes.fromhex('120576616c7565') + extra))

    def test_implicit_and_explicit_empty_string_are_equal(self):
        for extra in (b'', pb(3, '')):
            with self.subTest(extra=extra):
                self.assertEqual(self.value(extra), '')
                self.assertNotIsInstance(self.value(extra), base.CompiledBoolean)

    def test_compiled_empty_string_and_raw_string_remain_empty(self):
        for kind in (2, 3):
            for string in (b'', pb(1, '')):
                with self.subTest(kind=kind, string=string):
                    self.assertEqual(self.value(pb(6, pb(kind, string))), '')

    def test_typed_boolean_false_retains_presence_and_type(self):
        value = self.value(pb(6, pb(7, pb(8, 0))))
        self.assertEqual(value, 'false')
        self.assertIsInstance(value, base.CompiledBoolean)
        self.assertNotIsInstance(self.value(pb(3, 'false')), base.CompiledBoolean)
        self.assertNotIsInstance(self.value(), base.CompiledBoolean)

    def test_present_empty_or_unknown_compiled_item_never_uses_raw_fallback(self):
        for compiled in (b'', pb(6, b''), pb(99, b''), pb(7, b''), pb(7, pb(1, b'')), pb(7, pb(2, b''))):
            for raw in ('', 'false', 'DO_NOT_REPORT_SENTINEL'):
                with self.subTest(compiled=compiled, raw=raw):
                    self.assertEqual(self.value(pb(3, raw) + pb(6, compiled)), '@unresolved')

    def test_reference_never_becomes_empty_or_boolean_from_raw(self):
        for reference, expected in ((b'', '@unresolved'), (pb(2, 0x7f010001), '@0x7f010001'),
                                    (pb(3, 'string/value'), '@string/value')):
            for raw in ('', 'false'):
                with self.subTest(reference=reference, raw=raw):
                    value = self.value(pb(3, raw) + pb(6, pb(1, reference)))
                    self.assertEqual(value, expected)
                    self.assertNotIsInstance(value, base.CompiledBoolean)

    def test_wrong_wire_or_duplicate_fields_are_not_accepted_as_empty(self):
        typed_false = pb(6, pb(7, pb(8, 0)))
        for raw in (pb(3, 0), pb(6, 0), pb(3, '') + pb(3, ''), pb(6, b'') + pb(6, b''),
                    pb(3, 0) + typed_false, pb(3, '') + pb(3, '') + typed_false):
            with self.subTest(raw=raw), self.assertRaises(base.InvalidArtifact):
                self.value(raw)

    def test_canonical_aab_empty_values_pass_both_modes_but_attribute_removal_fails(self):
        for mode in privacy.MODES:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                xml = omit_empty_attribute_values(fixtures.manifest(mode))
                report = privacy.verify_artifact(fixtures.artifact(tmp, mode=mode, xml=xml), mode)
                self.assertEqual(report['status'], 'passed', report)
                root = base.proto_xml(xml)
                target = privacy.singleton(base.application(root), 'meta-data', 'ponlet_privacy_api_origin')
                del target.attrib[privacy.A + 'value']
                with self.assertRaises(base.InvalidArtifact):
                    privacy.verify_manifest(root, mode)
                target.set(privacy.A + 'value', self.value(pb(6, b'')))
                with self.assertRaises(base.InvalidArtifact):
                    privacy.verify_manifest(root, mode)


if __name__ == '__main__':
    unittest.main()
