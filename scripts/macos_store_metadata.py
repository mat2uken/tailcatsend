#!/usr/bin/env python3
"""Non-secret macOS Store build metadata and validation helpers."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess

TEAM = 'K7VNGA9K78'
GROUP = 'group.jp.yasagure.ponlet.k7vnga9k78'
IDS = ('jp.yasagure.ponlet', 'jp.yasagure.ponlet.share')


def build_number(run, attempt, override=''):
    # 8,999 runs x 99 attempts; reserve earlier major values for existing builds. Never wrap/modulo: exhaustion requires a new plan.
    value = override or f'{1000 + int(run)}.0.{int(attempt)}'
    if not re.fullmatch(r'[1-9][0-9]{0,3}\.(?:0|[1-9][0-9]?)\.(?:0|[1-9][0-9]?)', value):
        raise ValueError('Build must have three numeric components: 1..9999, 0..99, 0..99')
    if not override and (not 1 <= int(run) <= 8999 or not 1 <= int(attempt) <= 99):
        raise ValueError('Run attempt exhausted; supply a unique explicit build')
    return value


def profile_check(p, bundle, fingerprint):
    e = p.get('Entitlements', {})
    assert p.get('TeamIdentifier') == [TEAM], 'Wrong team'
    assert p.get('Platform') == ['OSX'], 'Not a macOS profile'
    assert e.get('com.apple.application-identifier') == f'{TEAM}.{bundle}', 'Wrong bundle ID'
    assert e.get('com.apple.developer.team-identifier') == TEAM, 'Wrong entitlement team'
    assert GROUP in e.get('com.apple.security.application-groups', []), 'Missing App Group'
    assert not e.get('get-task-allow') and not e.get('com.apple.security.get-task-allow'), 'Development profile'
    assert not p.get('ProvisionedDevices') and not p.get('ProvisionsAllDevices'), 'Not a Store profile'
    assert p['ExpirationDate'] > dt.datetime.now(dt.timezone.utc).replace(tzinfo=None), 'Expired profile'
    assert any(hashlib.sha1(c).hexdigest().upper() == fingerprint.upper() for c in p['DeveloperCertificates']), 'Certificate/profile mismatch'
    assert re.fullmatch(r'[A-Fa-f0-9-]{36}', p['UUID']), 'Invalid profile UUID'
    return p['UUID']


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL).decode().strip()


def bundle_check(app, version, build, store=False, fingerprint=None):
    results = []
    for root, bundle, executable, entpath in (
        (app, IDS[0], 'Ponlet', 'MacApp/Ponlet.entitlements'),
        (app / 'Contents/PlugIns/PonletShareExtensionMac.appex', IDS[1], 'PonletShareExtensionMac', 'ShareExtensionMac/PonletShareExtension.entitlements'),
    ):
        info = plistlib.loads((root / 'Contents/Info.plist').read_bytes())
        assert (info['CFBundleIdentifier'], info['CFBundleShortVersionString'], info['CFBundleVersion']) == (bundle, version, build), 'Bundle/version/build mismatch'
        binary = root / 'Contents/MacOS' / executable
        assert set(run('lipo', '-archs', str(binary)).split()) == {'arm64', 'x86_64'}, 'Not universal'
        subprocess.run(['codesign', '--verify', '--strict', str(root)], check=True, capture_output=True)
        effective = plistlib.loads(subprocess.check_output(['codesign', '-d', '--entitlements', ':-', str(root)], stderr=subprocess.DEVNULL))
        expected = plistlib.loads((Path('apps/tauri/gen/apple') / entpath).read_bytes())
        for key, value in expected.items():
            assert effective.get(key) == value, f'Entitlement mismatch: {key}'
        assert not effective.get('com.apple.security.get-task-allow') and not effective.get('get-task-allow'), 'Debug entitlement'
        allowed = set(expected) | ({'com.apple.application-identifier', 'com.apple.developer.team-identifier'} if store else set())
        assert set(effective) <= allowed, 'Unexpected extra entitlement'
        if store:
            signature = subprocess.run(['codesign', '-dv', '--verbose=4', str(root)], capture_output=True, text=True, check=True).stderr
            assert f'TeamIdentifier={TEAM}' in signature, 'Wrong signing team'
            import tempfile
            with tempfile.TemporaryDirectory() as tmp:
                prefix = str(Path(tmp) / 'cert')
                subprocess.run(['codesign', '-d', '--extract-certificates=' + prefix, str(root)], check=True, capture_output=True)
                assert hashlib.sha1(Path(prefix + '0').read_bytes()).hexdigest().upper() == fingerprint.upper(), 'Wrong signing certificate'
                subject = run('openssl', 'x509', '-inform', 'DER', '-in', prefix + '0', '-nameopt', 'RFC2253', '-noout', '-subject')
                assert any(kind in subject for kind in ('CN=Apple Distribution:', 'CN=3rd Party Mac Developer Application:', 'CN=Mac App Distribution:')), 'Not an App Store distribution certificate'
            assert effective.get('com.apple.application-identifier') == f'{TEAM}.{bundle}', 'Missing Store application ID'
            assert effective.get('com.apple.developer.team-identifier') == TEAM, 'Wrong effective entitlement team'
            decoded = subprocess.check_output(['security', 'cms', '-D', '-i', str(root / 'Contents/embedded.provisionprofile')], stderr=subprocess.DEVNULL)
            profile_check(plistlib.loads(decoded), bundle, fingerprint)
        assert (root / 'Contents/Resources/PrivacyInfo.xcprivacy').exists(), 'Missing privacy manifest'
        results.append({'bundle': bundle, 'version': version, 'build': build, 'entitlements': effective, 'uuids': run('dwarfdump', '--uuid', str(binary))})
    return results


def code_hashes(app, temp):
    results = {}
    for name, relative in [('main', 'Contents/MacOS/Ponlet'), ('share', 'Contents/PlugIns/PonletShareExtensionMac.appex/Contents/MacOS/PonletShareExtensionMac')]:
        for arch in ('arm64', 'x86_64'):
            dst = temp / f'{name}-{arch}'
            subprocess.run(['lipo', str(app / relative), '-thin', arch, '-output', str(dst)], check=True, capture_output=True)
            subprocess.run(['codesign', '--remove-signature', str(dst)], check=True, capture_output=True)
            results[f'{name}-{arch}'] = hashlib.sha256(dst.read_bytes()).hexdigest()
            dst.unlink()
    return results


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='action', required=True)
    n = sub.add_parser('number'); n.add_argument('run'); n.add_argument('attempt'); n.add_argument('--override', default='')
    q = sub.add_parser('compare'); q.add_argument('candidate'); q.add_argument('previous')
    s = sub.add_parser('set-number'); s.add_argument('number')
    c = sub.add_parser('profile'); c.add_argument('path'); c.add_argument('bundle', choices=IDS); c.add_argument('fingerprint')
    b = sub.add_parser('bundle'); b.add_argument('path'); b.add_argument('version'); b.add_argument('build'); b.add_argument('--fingerprint')
    h = sub.add_parser('hash-code'); h.add_argument('path'); h.add_argument('temp')
    args = p.parse_args()
    if args.action == 'number': print(build_number(args.run, args.attempt, args.override))
    elif args.action == 'compare':
        candidate = build_number(1, 1, args.candidate)
        previous = build_number(1, 1, args.previous)
        assert tuple(map(int,candidate.split('.'))) > tuple(map(int,previous.split('.'))), 'Candidate must exceed the user-confirmed latest ASC build'
    elif args.action == 'set-number':
        value = build_number(1, 1, args.number)
        path = Path('apps/tauri/gen/apple/project.yml')
        text = path.read_text(); head, mac = text.split('  tailsend-tauri_macOS:', 1)
        mac, count = re.subn(r'CFBundleVersion: "[^"]+"', f'CFBundleVersion: "{value}"', mac)
        assert count == 2, 'Expected exactly two macOS build numbers'
        path.write_text(head + '  tailsend-tauri_macOS:' + mac)
    elif args.action == 'profile': print(profile_check(plistlib.loads(Path(args.path).read_bytes()), args.bundle, args.fingerprint))
    elif args.action == 'bundle': print(json.dumps(bundle_check(Path(args.path), args.version, args.build, bool(args.fingerprint), args.fingerprint), indent=2))
    elif args.action == 'hash-code': print(json.dumps(code_hashes(Path(args.path), Path(args.temp)), indent=2, sort_keys=True))

if __name__ == '__main__': main()
