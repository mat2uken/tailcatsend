#!/usr/bin/env python3
"""Read-only Android AAB/APK checks using Python's standard library.

This verifies static packaging, not execution on a 16 KB Android device. AAB
alignment is a bundletool request, not proof of generated APK ZIP alignment.
Schema sources: google/bundletool src/main/proto/config.proto; AOSP aapt2
Resources.proto and ResourceTypes.h. Only manifest fields needed for review are
reported; only whitelisted advertising booleans from metadata are reported,
never other application metadata or Firebase configuration values.
"""
import argparse
import hashlib
import json
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

PAGE = 16384
ANDROID = 'http://schemas.android.com/apk/res/android'
PT_LOAD = 1
PT_GNU_RELRO = 0x6474E552


class InvalidArtifact(ValueError):
    pass


class CompiledBoolean(str):
    """Retain the type: a metadata string 'false' is not a boolean false."""
    pass


def require(condition, message):
    if not condition:
        raise InvalidArtifact(message)


def varint(data, pos):
    value = 0
    for shift in range(0, 70, 7):
        require(pos < len(data), 'truncated protobuf varint')
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            require(value < 1 << 64, 'protobuf varint overflow')
            return value, pos
    raise InvalidArtifact('protobuf varint too long')


def protobuf(data):
    fields = {}
    pos = 0
    while pos < len(data):
        key, pos = varint(data, pos)
        number, wire = key >> 3, key & 7
        require(number > 0, 'invalid protobuf field zero')
        if wire == 0:
            value, pos = varint(data, pos)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            require(pos + size <= len(data), 'truncated protobuf fixed field')
            value = data[pos:pos + size]
            pos += size
        elif wire == 2:
            size, pos = varint(data, pos)
            require(pos + size <= len(data), 'truncated protobuf bytes field')
            value = data[pos:pos + size]
            pos += size
        else:
            raise InvalidArtifact(f'unsupported protobuf wire type {wire}')
        fields.setdefault(number, []).append((wire, value))
    return fields


def field(fields, number, wire, default=None):
    values = fields.get(number, [])
    require(len(values) <= 1, f'duplicate protobuf scalar field {number}')
    if not values:
        return default
    require(values[0][0] == wire, f'wrong protobuf wire type for field {number}')
    return values[0][1]


def string(fields, number, default=''):
    return field(fields, number, 2, default.encode()).decode('utf-8')


def proto_value(attribute):
    # XmlAttribute.value is an implicit-presence proto3 string. An empty
    # uncompiled value is omitted on the wire; it still means an empty string.
    # Distinguish an absent compiled_item from a present but unsupported Item.
    # AOSP tools/aapt2/Resources.proto: XmlAttribute fields 3 and 6.
    raw = field(attribute, 3, 2, b'')
    compiled_data = field(attribute, 6, 2)
    if compiled_data is None:
        return raw.decode('utf-8')
    compiled = protobuf(compiled_data)
    if 1 in compiled:
        reference = protobuf(field(compiled, 1, 2))
        resource_id = field(reference, 2, 0, 0)
        if resource_id:
            return f'@0x{resource_id:08x}'
        name = string(reference, 3)
        return '@' + name if name else '@unresolved'
    for key in (2, 3):
        if key in compiled:
            return string(protobuf(field(compiled, key, 2)), 1)
    if 7 in compiled:
        primitive = protobuf(field(compiled, 7, 2))
        if 8 in primitive:
            return CompiledBoolean('true' if field(primitive, 8, 0) else 'false')
        for key in (6, 7):
            if key in primitive:
                return str(field(primitive, key, 0))
    # An unresolved compiled reference must not be interpreted as a raw boolean.
    return '@unresolved'


def proto_xml(data, depth=0):
    require(depth < 128, 'protobuf XML nesting too deep')
    node = protobuf(data)
    require(not (1 in node and 2 in node), 'ambiguous protobuf XML node')
    if 2 in node:
        return None
    element = protobuf(field(node, 1, 2, b''))
    name = string(element, 3)
    require(bool(name), 'missing protobuf XML element name')
    uri = string(element, 2)
    result = ET.Element(f'{{{uri}}}{name}' if uri else name)
    for wire, value in element.get(4, []):
        require(wire == 2, 'invalid protobuf XML attribute')
        attr = protobuf(value)
        name, uri = string(attr, 2), string(attr, 1)
        require(bool(name), 'missing protobuf XML attribute name')
        key = f'{{{uri}}}{name}' if uri else name
        require(key not in result.attrib, 'duplicate XML attribute')
        result.set(key, proto_value(attr))
    for wire, value in element.get(5, []):
        require(wire == 2, 'invalid protobuf XML child')
        child = proto_xml(value, depth + 1)
        if child is not None:
            result.append(child)
    return result


def unpack(fmt, data, offset):
    size = struct.calcsize(fmt)
    require(0 <= offset <= len(data) - size, 'truncated binary structure')
    return struct.unpack_from(fmt, data, offset)


def binary_strings(chunk):
    _, header_size, total = unpack('<HHI', chunk, 0)
    require(header_size >= 28 and total == len(chunk), 'invalid string pool header')
    count, styles, flags, start, style_start = unpack('<IIIII', chunk, 8)
    require(header_size + (count + styles) * 4 <= start <= total,
            'invalid string pool offsets')
    limit = style_start or total
    require(start <= limit <= total, 'invalid string pool end')
    result = []
    for index in range(count):
        offset = unpack('<I', chunk, header_size + index * 4)[0] + start
        require(start <= offset < limit, 'string pool index outside data')
        def length(pos, utf8):
            if utf8:
                require(pos < limit, 'truncated UTF-8 length')
                first = chunk[pos]
                pos += 1
                if first & 128:
                    require(pos < limit, 'truncated UTF-8 length')
                    return ((first & 127) << 8) | chunk[pos], pos + 1
                return first, pos
            first = unpack('<H', chunk[:limit], pos)[0]
            pos += 2
            if first & 0x8000:
                second = unpack('<H', chunk[:limit], pos)[0]
                return ((first & 0x7FFF) << 16) | second, pos + 2
            return first, pos
        utf8 = bool(flags & 0x100)
        chars, offset = length(offset, utf8)
        if utf8:
            size, offset = length(offset, True)
            end = offset + size
            require(end < limit and chunk[end] == 0, 'invalid UTF-8 string termination')
            text = chunk[offset:end].decode('utf-8')
            require(len(text.encode('utf-16-le')) // 2 == chars, 'UTF-8 character length mismatch')
        else:
            end = offset + chars * 2
            require(end + 2 <= limit and chunk[end:end + 2] == b'\0\0', 'invalid UTF-16 string termination')
            text = chunk[offset:end].decode('utf-16-le')
        result.append(text)
    return result


def binary_xml(data):
    kind, header_size, total = unpack('<HHI', data, 0)
    require(kind == 3 and header_size == 8 and total == len(data), 'invalid binary XML header')
    strings, stack, root = None, [], None
    pos = header_size
    def text(index):
        if index == 0xFFFFFFFF:
            return ''
        require(strings is not None and index < len(strings), 'invalid XML string index')
        return strings[index]
    while pos < total:
        kind, header, size = unpack('<HHI', data, pos)
        require(8 <= header <= size and pos + size <= total, 'invalid binary XML chunk')
        chunk = data[pos:pos + size]
        if kind == 1:
            require(strings is None and not stack and root is None, 'unexpected duplicate XML string pool')
            strings = binary_strings(chunk)
        elif kind == 0x102:
            require(strings is not None and header >= 16, 'invalid XML start element header')
            ns, name, attr_start, attr_size, count, _, _, _ = unpack('<IIHHHHHH', chunk, header)
            require(attr_size >= 20 and attr_start >= 20 and header + attr_start + count * attr_size <= size,
                    'invalid binary XML attributes')
            tag, uri = text(name), text(ns)
            require(bool(tag), 'empty XML tag')
            element = ET.Element(f'{{{uri}}}{tag}' if uri else tag)
            for index in range(count):
                off = header + attr_start + index * attr_size
                ns, name, raw, value_size, reserved, value_type, value = unpack('<IIIHBBI', chunk, off)
                require(value_size == 8 and reserved == 0, 'invalid XML typed value')
                name, uri = text(name), text(ns)
                require(bool(name), 'empty XML attribute name')
                if raw != 0xFFFFFFFF:
                    text(raw)  # Validate the index; typed data is authoritative.
                if value_type == 3:
                    value = text(value)
                elif value_type == 0x12:
                    value = CompiledBoolean('true' if value else 'false')
                elif value_type in (0x10, 0x11):
                    value = str(value)
                elif value_type == 1 and value:
                    value = f'@0x{value:08x}'
                else:
                    value = '@unresolved'
                key = f'{{{uri}}}{name}' if uri else name
                require(key not in element.attrib, 'duplicate XML attribute')
                element.set(key, value)
            if stack:
                stack[-1].append(element)
            else:
                require(root is None, 'multiple XML roots')
                root = element
            stack.append(element)
            require(len(stack) <= 128, 'binary XML nesting too deep')
        elif kind == 0x103:
            require(stack and header >= 16, 'unexpected XML end element')
            ns, name = unpack('<II', chunk, header)
            uri, tag = text(ns), text(name)
            require(stack[-1].tag == (f'{{{uri}}}{tag}' if uri else tag), 'mismatched XML end element')
            stack.pop()
        elif kind in (0x100, 0x101):
            require(header == 16 and size == 24, 'invalid XML namespace chunk')
            prefix, uri = unpack('<II', chunk, header)
            text(prefix); text(uri)
        elif kind == 0x104:
            require(header == 16 and size == 28 and stack, 'invalid XML text chunk')
            text(unpack('<I', chunk, header)[0])
        elif kind == 0x180:
            require(header == 8 and (size - header) % 4 == 0 and strings is not None, 'invalid XML resource map')
        else:
            raise InvalidArtifact(f'unknown binary XML chunk {kind:#x}')
        pos += size
    require(root is not None and not stack, 'incomplete binary XML document')
    return root


def manifest_summary(root):
    require(root.tag == 'manifest', 'manifest root missing')
    def android(node, name, default=None):
        return node.get(f'{{{ANDROID}}}{name}', default)
    def decimal(value, label):
        require(value is not None and value.isdecimal(), f'missing or unresolved {label}')
        return int(value)
    package = root.get('package')
    require(package and not package.startswith('@'), 'missing or unresolved package')
    uses_sdk = root.findall('uses-sdk')
    require(len(uses_sdk) == 1, 'expected one uses-sdk element')
    version_name = android(root, 'versionName')
    require(version_name is not None and not version_name.startswith('@'), 'missing or unresolved versionName')
    result = {'package': package, 'version_code': decimal(android(root, 'versionCode'), 'versionCode'),
              'version_name': version_name,
              'min_sdk': decimal(android(uses_sdk[0], 'minSdkVersion'), 'minSdkVersion'),
              'target_sdk': decimal(android(uses_sdk[0], 'targetSdkVersion'), 'targetSdkVersion')}
    require(1 <= result['min_sdk'] <= result['target_sdk'], 'invalid min/target SDK ordering')
    require(1 <= result['version_code'] <= 2100000000, 'versionCode outside Google Play range')
    permissions = {android(n, 'name') for n in root if n.tag in ('uses-permission', 'uses-permission-sdk-23')}
    require(all(p and not p.startswith('@') for p in permissions), 'permission with missing or unresolved name')
    result['permissions'] = sorted(permissions)
    cameras = []
    for node in root.findall('uses-feature'):
        name = android(node, 'name', '')
        require(not name.startswith('@'), 'unresolved uses-feature name')
        if name.startswith('android.hardware.camera'):
            value = android(node, 'required', 'true')
            require(value in ('true', 'false'), f'unresolved camera required value: {name}')
            cameras.append({'name': name, 'required': value == 'true'})
    result['camera_features'] = cameras
    optional = {c['name'] for c in cameras if not c['required']}
    result['camera_implied_required'] = []
    if 'android.permission.CAMERA' in permissions:
        result['camera_implied_required'] = sorted({'android.hardware.camera', 'android.hardware.camera.autofocus'} - optional)
    result['camera_optional'] = not any(c['required'] for c in cameras) and not result['camera_implied_required']
    return result

AD_ID_PERMISSIONS = {
    'com.google.android.gms.permission.AD_ID',
    'android.permission.ACCESS_ADSERVICES_AD_ID',
    'android.permission.ACCESS_ADSERVICES_ATTRIBUTION',
}
AD_ID_FLAGS = (
    'google_analytics_adid_collection_enabled',
    'google_analytics_default_allow_ad_personalization_signals',
)


def application(root):
    apps = root.findall('application')
    require(len(apps) == 1, 'expected one application element')
    return apps[0]


def verify_no_ad_id(root, permissions):
    """Whitelist only these booleans; never return other metadata values."""
    present = sorted(AD_ID_PERMISSIONS.intersection(permissions))
    require(not present, 'advertising permission remains: ' + ', '.join(present))
    app = application(root)
    flags = {}
    for name in AD_ID_FLAGS:
        nodes = [n for n in app.findall('meta-data') if n.get(f'{{{ANDROID}}}name') == name]
        require(len(nodes) == 1, f'expected one advertising metadata flag {name}')
        value = nodes[0].get(f'{{{ANDROID}}}value')
        require(isinstance(value, CompiledBoolean) and value == 'false',
                f'advertising metadata flag {name} is not an explicitly compiled boolean false')
        flags[name] = False
    return {'flags': flags, 'advertising_permissions': []}


def repeated_messages(fields, number):
    for wire, data in fields.get(number, []):
        require(wire == 2, 'invalid resource protobuf message')
        yield protobuf(data)


def proto_xml_resources(data):
    """Map XML resource IDs to every configured file. Aliases stay unresolved."""
    paths, names = {}, {}
    for package in repeated_messages(protobuf(data), 2):
        package_id = field(protobuf(field(package, 1, 2, b'')), 1, 0, 0)
        package_name = string(package, 2)
        require(1 <= package_id <= 255, 'invalid protobuf resource package ID')
        for resource_type in repeated_messages(package, 3):
            if string(resource_type, 2) != 'xml':
                continue
            type_id = field(protobuf(field(resource_type, 1, 2, b'')), 1, 0, 0)
            require(1 <= type_id <= 255, 'invalid protobuf resource type ID')
            for entry in repeated_messages(resource_type, 3):
                entry_id = field(protobuf(field(entry, 1, 2, b'')), 1, 0, 0)
                require(0 <= entry_id <= 65535, 'invalid protobuf resource entry ID')
                resource_id = package_id << 24 | type_id << 16 | entry_id
                require(resource_id not in paths, 'duplicate protobuf XML resource ID')
                values = set()
                for config in repeated_messages(entry, 6):
                    value = protobuf(field(config, 2, 2, b''))
                    item = protobuf(field(value, 4, 2, b''))
                    file = protobuf(field(item, 5, 2, b''))
                    values.add(string(file, 1) or None)
                paths[resource_id] = values
                name = string(entry, 2)
                for reference in (f'@xml/{name}', f'@{package_name}:xml/{name}'):
                    names.setdefault(reference, set()).add(resource_id)
    return paths, names


def binary_chunks(data, start, end):
    pos = start
    while pos < end:
        kind, header, size = unpack('<HHI', data, pos)
        require(8 <= header <= size and pos + size <= end, 'invalid resource table chunk')
        yield kind, header, data[pos:pos + size]
        pos += size
    require(pos == end, 'incomplete resource table chunks')


def binary_xml_resources(data):
    """Read file-string values from ARSC. Other types/aliases cannot resolve XML.

    Handles ordinary, sparse/16-bit offsets and compact simple entries. It does
    not evaluate resource aliases, bags, overlays or runtime dynamic references.
    Missing/unsupported references fail the backup check rather than pass it.
    """
    kind, header, total = unpack('<HHI', data, 0)
    require(kind == 2 and header >= 12 and total == len(data), 'invalid resources.arsc header')
    package_count = unpack('<I', data, 8)[0]
    strings, packages = None, []
    for kind, subheader, chunk in binary_chunks(data, header, total):
        if kind == 1:
            require(strings is None, 'duplicate global resource string pool')
            strings = binary_strings(chunk)
        elif kind == 0x200:
            packages.append((subheader, chunk))
    require(strings is not None and len(packages) == package_count, 'incomplete resources.arsc packages')
    paths = {}
    for package_header, package in packages:
        require(package_header >= 284, 'unsupported resource package header')
        package_id = unpack('<I', package, 8)[0]
        type_offset = unpack('<I', package, 284)[0] if package_header >= 288 else 0
        require(1 <= package_id <= 255, 'invalid binary resource package ID')
        for kind, type_header, chunk in binary_chunks(package, package_header, len(package)):
            if kind != 0x201:
                continue
            require(type_header >= 24, 'invalid resource type header')
            type_id, flags, reserved, count, entry_start = unpack('<BBHII', chunk, 8)
            require(type_id and type_id + type_offset <= 255 and reserved == 0 and flags in (0, 1, 2), 'unsupported resource type flags/ID')
            config_size = unpack('<I', chunk, 20)[0]
            require(config_size >= 4 and 20 + config_size <= type_header, 'invalid resource configuration size')
            offset_size = 2 if flags == 2 else 4
            require(type_header + count * offset_size <= entry_start <= len(chunk), 'invalid resource entry offsets')
            for index in range(count):
                if flags == 1:
                    entry_index, off = unpack('<HH', chunk, type_header + index * 4)
                    off *= 4
                elif flags == 2:
                    entry_index = index
                    value = unpack('<H', chunk, type_header + index * 2)[0]
                    off = value * 4 if value != 0xFFFF else 0xFFFFFFFF
                else:
                    entry_index = index
                    off = unpack('<I', chunk, type_header + index * 4)[0]
                if off == 0xFFFFFFFF:
                    continue
                require(entry_index <= 65535, 'resource entry index out of range')
                resource_id = package_id << 24 | (type_id + type_offset) << 16 | entry_index
                start = entry_start + off
                entry_size, entry_flags, value = unpack('<HHI', chunk, start)
                if entry_flags & 1:
                    paths.setdefault(resource_id, set()).add(None)
                    continue
                if entry_flags & 8:
                    value_type = entry_flags >> 8
                else:
                    require(entry_size >= 8, 'invalid full resource entry size')
                    value_size, zero, value_type, value = unpack('<HBBI', chunk, start + entry_size)
                    require(value_size == 8 and zero == 0, 'invalid resource typed value')
                if value_type == 3:
                    require(value < len(strings), 'invalid resource value string index')
                    resource_path = strings[value]
                else:
                    resource_path = None
                paths.setdefault(resource_id, set()).add(resource_path)
    return paths, {}


def resolve_xml(reference, resource_paths, resource_names):
    require(reference is not None and reference.startswith('@'), 'backup policy is not a resource reference')
    if reference.startswith('@0x'):
        require(len(reference) == 11, 'invalid backup policy resource ID')
        try:
            resource_id = int(reference[1:], 16)
        except ValueError:
            raise InvalidArtifact('invalid backup policy resource ID')
    else:
        matches = resource_names.get(reference, set())
        require(len(matches) == 1, 'backup XML name reference missing or ambiguous')
        resource_id = next(iter(matches))
    paths = resource_paths.get(resource_id, set())
    require(paths and all(p and p.startswith('res/') and p.endswith('.xml') and '..' not in p.split('/') for p in paths),
            'backup XML reference missing, aliased, or unsupported')
    return sorted(paths)


def received_exclusion(node):
    require(node.tag == 'exclude' and node.attrib.get('domain') == 'file' and
            node.attrib.get('path') in ('received', 'received/') and
            set(node.attrib) == {'domain', 'path'} and len(node) == 0,
            'backup rule must exclude only file/received and preserve other files/preferences')


def backup_policy(kind, node):
    if kind == 'fullBackupContent':
        require(node.tag == 'full-backup-content' and not node.attrib and len(node) == 1,
                'legacy backup policy must contain only received exclusion')
        received_exclusion(node[0])
        return {'received_excluded': True, 'other_files_preferences_preserved': True,
                'scope': 'legacy cloud backup and device transfer; API 31+ uses dataExtractionRules'}
    require(node.tag == 'data-extraction-rules' and not node.attrib and len(node) == 2,
            'data extraction policy must define cloud-backup and device-transfer')
    cloud, transfer = node.findall('cloud-backup'), node.findall('device-transfer')
    require(len(cloud) == len(transfer) == 1 and len(cloud[0]) == 1 and not cloud[0].attrib,
            'cloud-backup must contain only received exclusion without disabling all backup')
    received_exclusion(cloud[0][0])
    require(len(transfer[0]) == 0 and not transfer[0].attrib,
            'device-transfer must preserve received files and preferences')
    return {'cloud_received_excluded': True, 'cloud_other_files_preferences_preserved': True,
            'device_transfer_all_preserved': True}


def verify_received_cloud_excluded(root, archive, aab):
    app = application(root)
    allow = app.get(f'{{{ANDROID}}}allowBackup', 'true')
    require(allow == 'true', 'allowBackup must remain true to preserve preferences/device transfer')
    name = 'base/resources.pb' if aab else 'resources.arsc'
    require(name in archive.namelist(), 'compiled resource table missing for backup verification')
    resource_paths, resource_names = (proto_xml_resources if aab else binary_xml_resources)(archive.read(name))
    policies = {'allow_backup': True}
    for kind in ('fullBackupContent', 'dataExtractionRules'):
        reference = app.get(f'{{{ANDROID}}}{kind}')
        paths = resolve_xml(reference, resource_paths, resource_names)
        variants = []
        for path in paths:
            member = 'base/' + path if aab else path
            require(member in archive.namelist(), 'referenced backup XML missing from artifact')
            raw = archive.read(member)
            policy_root = (proto_xml if aab else binary_xml)(raw)
            variants.append({'path': member, **backup_policy(kind, policy_root)})
        policies[kind] = {'reference': reference, 'variants': variants}
    return policies


def elf_summary(data):
    require(len(data) >= 16 and data[:4] == b'\x7fELF', 'not an ELF file')
    cls, encoding, version = data[4:7]
    require(cls in (1, 2) and encoding in (1, 2) and version == 1, 'unsupported ELF encoding')
    endian = '<' if encoding == 1 else '>'
    fmt = endian + ('HHIIIIIHHHHHH' if cls == 1 else 'HHIQQQIHHHHHH')
    header = unpack(fmt, data, 16)
    elf_type, machine, elf_version, _, phoff, _, _, ehsize, phsize, count, *_ = header
    require(elf_type == 3 and elf_version == 1, 'native library is not ELF ET_DYN version 1')
    expected_header = 52 if cls == 1 else 64
    expected_ph = 32 if cls == 1 else 56
    require(ehsize == expected_header and phsize == expected_ph and count not in (0, 0xFFFF), 'invalid ELF program headers')
    require(phoff >= ehsize and phoff + phsize * count <= len(data), 'ELF program headers outside file')
    loads, relros = [], []
    for index in range(count):
        values = unpack(endian + ('IIIIIIII' if cls == 1 else 'IIQQQQQQ'), data, phoff + index * phsize)
        if cls == 1:
            kind, offset, addr, _, filesz, memsz, flags, align = values
        else:
            kind, flags, offset, addr, _, filesz, memsz, align = values
        require(offset + filesz <= len(data), f'ELF segment {index} extends beyond file')
        if kind in (PT_LOAD, PT_GNU_RELRO):
            if kind == PT_LOAD:
                require(filesz <= memsz, f'ELF LOAD segment {index} filesz exceeds memsz')
            segment = {'index': index, 'offset': offset, 'vaddr': addr, 'filesz': filesz,
                       'memsz': memsz, 'flags': flags, 'alignment': align}
            if kind == PT_LOAD:
                segment['aligned_16k'] = align >= PAGE and align & (align - 1) == 0
                segment['congruent_16k'] = (offset - addr) % PAGE == 0
                loads.append(segment)
            else:
                segment['end_mod_16k'] = (addr + memsz) % PAGE
                relros.append(segment)
    require(loads, 'ELF has no LOAD segments')
    for relro in relros:
        end = relro['vaddr'] + relro['memsz']
        rounded = (end + PAGE - 1) // PAGE * PAGE
        # Supplementary diagnosis only: the documented modulo rule is separate.
        overlaps = []
        for load in loads:
            if load['flags'] & 2 and max(end, load['vaddr']) < min(rounded, load['vaddr'] + load['memsz']):
                overlaps.append(load['index'])
        relro['writable_loads_in_rounded_tail'] = overlaps
    return {'class': cls * 32, 'machine': machine, 'loads': loads, 'relro': relros}


def bundle_alignment(data):
    config = protobuf(data)
    optimizations = protobuf(field(config, 2, 2, b''))
    native = protobuf(field(optimizations, 2, 2, b''))
    value = field(native, 2, 0, 0)
    require(value in (0, 1, 2, 3), 'unknown BundleConfig page alignment enum')
    return {0: 'PAGE_ALIGNMENT_UNSPECIFIED', 1: 'PAGE_ALIGNMENT_4K',
            2: 'PAGE_ALIGNMENT_16K', 3: 'PAGE_ALIGNMENT_64K'}[value]


def verify(path, require_camera_optional=False, expect_version_code=None, strict_relro=False,
           require_no_ad_id=False, require_received_cloud_excluded=False):
    result = {'path': str(path), 'status': 'failed', 'errors': [], 'warnings': [], 'native_libraries': []}
    try:
        result['sha256'] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            require(len(names) == len(set(names)), 'duplicate ZIP entry names')
            aab = 'BundleConfig.pb' in names
            manifest_name = 'base/manifest/AndroidManifest.xml' if aab else 'AndroidManifest.xml'
            result['type'] = 'aab' if aab else 'apk'
            require(manifest_name in names, 'merged manifest missing')
            raw = archive.read(manifest_name)
            root = proto_xml(raw) if aab else binary_xml(raw)
            result['manifest'] = manifest_summary(root)
            if require_no_ad_id:
                try:
                    result['no_ad_id'] = verify_no_ad_id(root, result['manifest']['permissions'])
                except InvalidArtifact as error:
                    result['errors'].append(str(error))
            if require_received_cloud_excluded:
                try:
                    result['received_cloud_backup'] = verify_received_cloud_excluded(root, archive, aab)
                except InvalidArtifact as error:
                    result['errors'].append(str(error))
            if require_camera_optional and not result['manifest']['camera_optional']:
                result['errors'].append('merged manifest requires camera hardware')
            if expect_version_code is not None and result['manifest']['version_code'] != expect_version_code:
                result['errors'].append(f'versionCode does not match expected {expect_version_code}')
            if aab:
                result['bundle_page_alignment'] = bundle_alignment(archive.read('BundleConfig.pb'))
                if result['bundle_page_alignment'] != 'PAGE_ALIGNMENT_16K':
                    result['errors'].append('BundleConfig does not request PAGE_ALIGNMENT_16K')
            libraries = [n for n in names if n.endswith('.so') and '/lib/' in '/' + n]
            require(libraries, 'no native libraries found; alignment not verified')
            for name in sorted(libraries):
                library = {'path': name}
                result['native_libraries'].append(library)
                try:
                    library.update(elf_summary(archive.read(name)))
                    for load in library['loads']:
                        if not load['aligned_16k'] or not load['congruent_16k']:
                            result['errors'].append(f'{name}: LOAD {load["index"]} is not 16 KB aligned/congruent')
                    for relro in library['relro']:
                        if relro['end_mod_16k']:
                            message = f'{name}: RELRO {relro["index"]} end modulo 16 KB = {relro["end_mod_16k"]:#x}; guide-formula audit warning, not proof of runtime failure'
                            result['errors' if strict_relro else 'warnings'].append(message)
                    if not aab:
                        info = archive.getinfo(name)
                        with open(path, 'rb') as stream:
                            stream.seek(info.header_offset)
                            header = stream.read(30)
                        values = unpack('<IHHHHHIIIHH', header, 0)
                        require(values[0] == 0x04034B50, 'invalid ZIP local header')
                        offset = info.header_offset + 30 + values[-2] + values[-1]
                        library['zip_compressed'] = info.compress_type != zipfile.ZIP_STORED
                        library['zip_data_offset'] = offset
                        if not library['zip_compressed'] and offset % PAGE:
                            result['errors'].append(f'{name}: uncompressed APK entry is not ZIP-aligned to 16 KB')
                    else:
                        library['zip_alignment'] = 'not_applicable_to_aab; verify generated APK separately'
                except (InvalidArtifact, UnicodeError, struct.error) as error:
                    library['error'] = str(error)
                    result['errors'].append(f'{name}: {error}')
    except (OSError, zipfile.BadZipFile, KeyError, InvalidArtifact, UnicodeError, struct.error, ET.ParseError,
            NotImplementedError, RuntimeError, EOFError) as error:
        result['errors'].append(str(error))
    if not result['errors']:
        result['status'] = 'passed_with_warnings' if result['warnings'] else 'passed'
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', nargs='+', type=Path)
    parser.add_argument('--report', type=Path, help='write detailed JSON report')
    parser.add_argument('--require-camera-optional', action='store_true')
    parser.add_argument('--expect-version-code', type=int)
    parser.add_argument('--require-no-ad-id', action='store_true', help='require both Analytics advertising flags false and three advertising permissions absent')
    parser.add_argument('--require-received-cloud-excluded', action='store_true', help='resolve and check both backup XML policies; preserve other files/preferences and API 31+ device transfer')
    parser.add_argument('--strict-relro', action='store_true', help='fail the guide end-formula audit; not proof of runtime failure (default: warn)')
    args = parser.parse_args(argv)
    if args.expect_version_code is not None and not 1 <= args.expect_version_code <= 2100000000:
        parser.error('--expect-version-code must be in Google Play range 1..2100000000')
    reports = [verify(path, args.require_camera_optional, args.expect_version_code, args.strict_relro,
                      args.require_no_ad_id, args.require_received_cloud_excluded) for path in args.artifacts]
    payload = {'schema_version': 1, 'page_size': PAGE,
               'limitations': ['Static checks do not verify 16 KB device runtime behavior or signing.',
                               'AAB page alignment is only a request; verify generated APK ZIP alignment.',
                               'RELRO modulo alone does not prove runtime failure; investigate rounded protection and test SDK behavior.',
                               '--strict-relro is a guide-formula audit, not a published Play rejection algorithm.',
                               'Advertising and backup checks verify packaged configuration; device/SDK runtime behavior is not verified.'],
               'artifacts': reports}
    if args.report:
        args.report.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
    for report in reports:
        print(f'{report["status"]}: {report["path"]} ({len(report["native_libraries"])} native libraries)')
        if 'manifest' in report:
            value = report['manifest']
            print(f'  {value["package"]} {value["version_name"]} ({value["version_code"]}) minSDK={value["min_sdk"]} targetSDK={value["target_sdk"]} camera_optional={value["camera_optional"]}')
        for level in ('errors', 'warnings'):
            for message in report[level]:
                print(f'  {level[:-1]}: {message}')
    return 1 if any(r['errors'] for r in reports) else 0


if __name__ == '__main__':
    sys.exit(main())
