#!/usr/bin/env python3
"""Validate a reviewed archive artifact before accessing cloud signing credentials."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile


def verify(folder, expected_commit, expected_sha):
    if not re.fullmatch(r'[a-fA-F0-9]{40}', expected_commit or ''):
        raise ValueError('Expected source commit must be a complete SHA')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected_sha or ''):
        raise ValueError('Expected archive SHA256 is required')
    folder = Path(folder)
    metadata = json.loads((folder / 'build-input.json').read_text())
    if metadata.get('commit', '').lower() != expected_commit.lower() or metadata.get('input_dirty') is not False:
        raise ValueError('Archive source commit/clean state mismatch')
    archive = folder / 'Ponlet-preflight.xcarchive.zip'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_sha.lower():
        raise ValueError('Archive SHA256 mismatch')
    hashes = json.loads((folder / 'SHA256.json').read_text())
    for name in ('Ponlet-preflight.xcarchive.zip', 'Ponlet-local-sandbox.zip', 'build-input.json', 'executable-code-sha256.json'):
        path = folder / name
        if hashes.get(name) != hashlib.sha256(path.read_bytes()).hexdigest():
            raise ValueError('Input manifest SHA256 mismatch: ' + name)
    for filename, prefix in [('Ponlet-preflight.xcarchive.zip','Ponlet-preflight.xcarchive'), ('Ponlet-local-sandbox.zip','Ponlet.app')]:
        with zipfile.ZipFile(folder / filename) as z:
            for entry in z.infolist():
                parts = PurePosixPath(entry.filename).parts
                if entry.filename.startswith('/') or '..' in parts or not parts or parts[0] not in (prefix, '__MACOSX'):
                    raise ValueError('Unsafe ZIP member path')
                if stat.S_ISLNK(entry.external_attr >> 16):
                    if len(parts) < 2:
                        raise ValueError('Archive root cannot be a symlink')
                    target = z.read(entry).decode()
                    if target.startswith('/'):
                        raise ValueError('Absolute ZIP symlink')
                    depth = len(parts) - 1
                    for component in PurePosixPath(target).parts:
                        depth += -1 if component == '..' else 0 if component == '.' else 1
                        if depth < 1:
                            raise ValueError('ZIP symlink escapes archive root')
    return metadata

if __name__ == '__main__':
    verify(sys.argv[1], os.environ.get('EXPECTED_SOURCE_COMMIT'), os.environ.get('EXPECTED_ARCHIVE_SHA256'))
    print('Reviewed archive SHA256, clean source commit, and artifact manifest verified.')
