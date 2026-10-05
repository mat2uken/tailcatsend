#!/usr/bin/env python3
"""Opaque, ephemeral signed build validation. Never prints captured build output."""
import argparse
import contextlib
import base64
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

VERSION_CODE = '2030000102'
SIGNING_KEYS = ('ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD',
                'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')
INPUT_KEYS = (*SIGNING_KEYS, 'GOOGLE_SERVICES_JSON_BASE64')
EXPORT_ARTIFACTS = {'runtime': 'apk', 'bundle': 'aab'}
DERIVED_KEYS = {'PONLET_ANDROID_KEYSTORE', 'ANDROID_KEYSTORE_PASSWORD',
                'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'}
MARKER = b'PONLET_SIGNED_VALIDATION_GRAPH_OK'
SIGNATURE_DIAGNOSTIC_FIELDS = ('numbered_lines', 'sdk_range_lines',
                               'unknown_certificate_labels', 'unique_fingerprints',
                               'certificate_digest_tokens', 'indented_certificate_lines',
                               'certificate_dn_lines', 'signer_label_lines',
                               'pem_certificate_blocks', 'v2_verified_lines',
                               'v3_verified_lines', 'v31_verified_lines')
# Only reviewed verifier enum literals may reach a failure log.
SAFE_ERROR_CODES = frozenset(('aab_apk_public_certificates_differ', 'aab_public_certificate_missing', 'aab_signature_block_missing', 'aab_signature_not_verified', 'aab_signer_count_not_one', 'aab_unsigned_entries_present', 'apk_public_certificate_missing_or_ambiguous', 'apk_signature_not_verified', 'apk_signer_count_not_one', 'artifact_validation_failed', 'firebase_compiled_resource_decode_failed', 'firebase_compiled_resource_table_missing', 'firebase_project_does_not_match', 'firebase_required_resource_missing_blank_or_unresolved', 'invalid_compiled_resource_table', 'invalid_public_certificate_fingerprint', 'invalid_resource_configuration', 'invalid_resource_entry', 'invalid_resource_key_index', 'invalid_resource_key_pool', 'invalid_resource_offsets', 'invalid_resource_string_index', 'invalid_resource_type', 'invalid_resource_value', 'native_abi_not_arm64_only', 'native_elf_not_aarch64', 'release_metadata_does_not_match', 'safe_report_write_failed', 'signature_tool_failed', 'signature_tool_unavailable_or_timed_out', 'static_artifact_checks_failed', 'unknown_native_library_layout', 'unsupported_compiled_resource_table', 'unsupported_resource_type', 'wrong_artifact_extension'))


class ValidationError(Exception):
    pass


def debug_guard(incoming):
    if any(incoming.get(key, '').lower() in ('true', '1')
           for key in ('ACTIONS_STEP_DEBUG', 'ACTIONS_RUNNER_DEBUG', 'RUNNER_DEBUG')):
        raise ValidationError('debug logging must be disabled')


def source_guard(repo, expected, incoming):
    request('verify', expected, 'false')
    debug_guard(incoming)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True, stderr=subprocess.DEVNULL).strip()
    if actual != expected:
        raise ValidationError('source SHA mismatch')
    return actual


def request(mode, source, confirm):
    if mode not in ('verify', 'runtime', 'bundle', 'deploy'):
        raise ValidationError('unsupported mode')
    if mode in ('verify', 'runtime', 'bundle') and not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValidationError('verify requires a complete lowercase source SHA')
    if mode == 'deploy' and confirm != 'true':
        raise ValidationError('deploy requires explicit confirmation')


def parse_private_env(path, keystore):
    result = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition('=')
        if not separator or key not in DERIVED_KEYS or key in result or not value:
            raise ValidationError('invalid private signing environment')
        result[key] = value  # Literal data: never source/eval a password or alias.
    if set(result) != DERIVED_KEYS or result['PONLET_ANDROID_KEYSTORE'] != str(keystore):
        raise ValidationError('incomplete or misplaced signing environment')
    return result


def failure_category(content, return_code=None):
    # A diagnostic hint, not proof of the failure's underlying cause.
    content = re.sub(rb'\x1b\[[0-9;]*[A-Za-z]', b'', content).lower()
    if return_code in (-9, 137):
        return 'process-killed'
    for category, needles in (
        ('disk-space', (b'no space left on device', b'disk quota exceeded')),
        ('memory', (b'out of memory', b'cannot allocate memory', b'java heap space')),
        ('gradle-daemon', (b'gradle build daemon disappeared unexpectedly', b'daemon disappeared')),
        ('frontend-check', (b'formatting issues found', b'format check failed', b'tests failed', b'test failed', b'tsc: error')),
        ('patches', (b'cannot apply ', b'patch does not apply')),
        ('go-toolchain', (b'go: errors parsing go.mod', b'go tool compile:')),
        ('tool-missing', (b'command not found', b'no such file or directory')),
        ('sdk-dependency', (b'could not resolve', b'sdk location not found', b'failed to find platform')),
        ('gradle-control', (b'upload suppression', b'upload prohibited', b'build id task absent', b'release configuration missing', b'signed validation requires both firebase build plugins')),
        ('signature', (b'signing', b'keystore', b'signature')),
        ('resources', (b'android resource linking failed', b'processresources')),
        ('compile', (b'compilation failed', b'could not compile', b'compileerror'))):
        if any(needle in content for needle in needles):
            return category
    return 'unclassified'


def phase_event(phase, status, cwd, started=None, return_code=None, category=None, digest=None):
    # Only caller-owned literals, enums and numeric runner counters are public.
    event = {'validation_phase': phase, 'status': status}
    if started is not None:
        event['elapsed_seconds'] = round(time.monotonic() - started, 3)
    if return_code is not None:
        event['return_code'] = return_code
    if category is not None:
        event['category'] = category
    if digest is not None:
        event['log_sha256'] = digest
    try:
        event['disk_free_bytes'] = shutil.disk_usage(cwd).free
    except OSError:
        pass
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            match = re.fullmatch(r'MemAvailable:\s+(\d+) kB', line)
            if match:
                event['memory_available_bytes'] = int(match[1]) * 1024
                break
    except OSError:
        pass
    print(json.dumps(event, sort_keys=True), file=sys.stderr)


def run_private(command, cwd, env, work, phase, require_graph=False, json_output=None):
    log = work / (phase + '.log')
    started = time.monotonic()
    phase_event(phase, 'started', cwd)
    with contextlib.ExitStack() as stack:
        output = stack.enter_context(log.open('wb'))
        stdout = stack.enter_context(json_output.open('wb')) if json_output else output
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=stdout,
                                 stderr=output, start_new_session=True)
        try:
            return_code = child.wait()
        except BaseException:
            # On cancellation terminate the whole build tree before deleting private inputs.
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
            phase_event(phase, 'cancelled', cwd, started)
            raise
    content = log.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if return_code or (require_graph and MARKER not in content):
        # Never include command lines, raw logs, exception contents, or input values.
        category = failure_category(content, return_code) if return_code else 'graph-marker-missing'
        phase_event(phase, 'failed', cwd, started, return_code, category, digest)
        raise ValidationError('private subprocess failed')
    phase_event(phase, 'succeeded', cwd, started, return_code, digest=digest)
    return digest


def decode_firebase(encoded):
    # Existing CI secrets may be line-wrapped; accept only normal ASCII wrapping.
    compact = re.sub(r'[ \t\r\n]', '', encoded)
    return base64.b64decode(compact, validate=True)


def report_error_codes(path):
    try:
        report = json.loads(path.read_text())
        if not isinstance(report, dict):
            return []
        values = list(report.get('errors', []))
        for artifact in report.get('artifacts', []):
            if isinstance(artifact, dict):
                values.extend(artifact.get('errors', []))
        return sorted({value for value in values if isinstance(value, str) and value in SAFE_ERROR_CODES})
    except (OSError, ValueError, TypeError):
        return []


def report_signature_diagnostics(path):
    try:
        report = json.loads(path.read_text())
        if not isinstance(report, dict) or not isinstance(report.get('artifacts'), list):
            return None
        values = [artifact['signature_diagnostics'] for artifact in report['artifacts']
                  if isinstance(artifact, dict) and artifact.get('type') == 'apk'
                  and 'signature_diagnostics' in artifact]
        if len(values) != 1 or not isinstance(values[0], dict):
            return None
        counts = values[0]
        if set(counts) != set(SIGNATURE_DIAGNOSTIC_FIELDS):
            return None
        if any(type(value) is not int or not 0 <= value <= 128 for value in counts.values()):
            return None
        return {field: counts[field] for field in SIGNATURE_DIAGNOSTIC_FIELDS}
    except (OSError, ValueError, TypeError):
        return None


def publish_failure_report(path):
    payload = {}
    codes = report_error_codes(path)
    if codes:
        payload['artifact_error_codes'] = codes
    diagnostics = report_signature_diagnostics(path)
    if diagnostics is not None:
        payload['signature_diagnostics'] = diagnostics
    if payload:
        print(json.dumps(payload, sort_keys=True), file=sys.stderr)


def apksigner_version_diagnostic(apksigner):
    # A public SDK directory label is accepted only as three bounded digit groups.
    # Unknown labels and the tool's actual path are never included in the result.
    match = re.fullmatch(r'([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})', Path(apksigner).parent.name)
    if match is None:
        return {'apksigner_build_tools_version_known': False}
    return {'apksigner_build_tools_version': [int(part) for part in match.groups()]}


def prepare_tauri_settings(repo, metadata, destination):
    build = repo / 'apps/tauri/gen/android/app/tauri.build.gradle.kts'
    if destination.exists() or build.exists():
        raise ValidationError('existing generated Tauri files must remain untouched')
    # These are generated, untracked files. Use tracked declarations, not local leftovers.
    manifest = (repo / 'apps/tauri/Cargo.toml').read_text()
    plugins = re.findall(r'^(tauri-plugin-[a-z0-9-]+)\s*=', manifest, re.MULTILINE)
    if not plugins or len(plugins) != len(set(plugins)):
        raise ValidationError('ambiguous tracked plugin declarations')
    packages = metadata.get('packages', [])
    names = ['tauri-android', *sorted(plugins)]
    lines = ['// CI generated from locked Cargo metadata; product sources unchanged.']
    for name in names:
        package_name = 'tauri' if name == 'tauri-android' else name
        matches = [p for p in packages if p.get('name') == package_name]
        if len(matches) != 1:
            raise ValidationError('missing or ambiguous Tauri package metadata')
        crate = Path(matches[0]['manifest_path']).resolve().parent
        android = crate / ('mobile/android' if package_name == 'tauri' else 'android')
        if not android.is_dir():
            raise ValidationError('Tauri Android project directory absent')
        escaped = str(android).replace('\\', '\\\\').replace("'", "\\'")
        lines.extend([f"include ':{name}'", f"project(':{name}').projectDir = new File('{escaped}')"])
    builders = [p for p in packages if p.get('name') == 'tauri-build']
    if len(builders) != 1:
        raise ValidationError('ambiguous locked Tauri generator')
    generator = Path(builders[0]['manifest_path']).parent / 'src/mobile.rs'
    lifecycle = set(re.findall(r'androidx\.lifecycle:lifecycle-process:([0-9.]+)', generator.read_text()))
    if len(lifecycle) != 1:
        raise ValidationError('locked Tauri lifecycle dependency unavailable')
    app_lines = ['// CI preflight only; normal Tauri build regenerates this file.',
                 'val implementation by configurations', 'dependencies {',
                 '    implementation("androidx.lifecycle:lifecycle-process:' + lifecycle.pop() + '")']
    app_lines.extend('    implementation(project(":' + name + '"))' for name in names)
    app_lines.append('}')
    owned = []
    try:
        for target, content in ((destination, lines), (build, app_lines)):
            with target.open('x') as output:
                owned.append(target)
                output.write('\n'.join(content) + '\n')
    except BaseException:
        for target in owned:
            target.unlink(missing_ok=True)
        raise


def find_tool(sdk, name):
    choices = sorted((sdk / 'build-tools').glob('*/' + name),
                     key=lambda p: tuple(int(v) for v in p.parent.name.split('.') if v.isdigit()))
    if not choices:
        raise ValidationError('required Android build tool missing')
    return str(choices[-1])


def record_ownership(work, repo, paths):
    entries = []
    for path in paths:
        info = path.stat()
        entries.append({'path': str(path.resolve()), 'device': info.st_dev, 'inode': info.st_ino})
    marker = work / 'ownership.json'
    temporary = work / 'ownership.tmp'
    temporary.write_text(json.dumps({'repo': str(repo.resolve()), 'files': entries}))
    temporary.replace(marker)


def cleanup_export(repo, runner_temp, mode='runtime'):
    if mode not in EXPORT_ARTIFACTS:
        raise ValidationError('unsupported export cleanup mode')
    directory = Path(runner_temp) / ('ponlet-' + mode + '-export')
    if not directory.exists() or directory.is_symlink():
        return
    marker = directory / 'ownership.json'
    if not marker.is_file() or marker.is_symlink():
        return  # A caller-owned directory is never removed.
    try:
        record = json.loads(marker.read_text())
        remove_owned_export(repo, directory, record, mode)
    except (OSError, ValueError, TypeError):
        raise ValidationError(mode + ' export cleanup failed') from None


def remove_owned_export(repo, directory, record, mode):
    info = directory.stat()
    if directory.is_symlink() or record != {'repo': str(repo.resolve()), 'device': info.st_dev, 'inode': info.st_ino}:
        raise ValidationError(mode + ' export ownership mismatch')
    if any(p.name not in ('ownership.json', 'ponlet-release.' + EXPORT_ARTIFACTS[mode], 'export.tmp')
           or p.is_symlink() or not p.is_file() for p in directory.iterdir()):
        raise ValidationError(mode + ' export contains unowned files')
    shutil.rmtree(directory)


def audit_runtime_apk(apk, incoming, signing, firebase):
    # Shared APK/AAB archive audit of specified representations of private CI
    # inputs. Compiled Firebase strings and public signing certificates are allowed.
    needles = [Path(signing['PONLET_ANDROID_KEYSTORE']).read_bytes(), firebase]
    for key in ('ANDROID_KEYSTORE_BASE64', 'GOOGLE_SERVICES_JSON_BASE64'):
        needles.extend((incoming[key].encode(), re.sub(r'[ \t\r\n]', '', incoming[key]).encode()))
    for key in ('ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_PASSWORD'):
        needles.append(signing[key].encode())  # Passwords are checked at every length.
    alias = signing['ANDROID_KEY_ALIAS'].encode()
    if len(alias) >= 16:
        needles.append(alias)
    if any(not value for value in needles):
        raise ValidationError('runtime audit input missing')
    tail_length = max(max(map(len, needles)), 65536)
    assignments = re.compile(rb'(?:PONLET_ANDROID_KEYSTORE|ANDROID_KEYSTORE_BASE64|ANDROID_KEYSTORE_PASSWORD|ANDROID_KEY_ALIAS|ANDROID_KEY_PASSWORD|GOOGLE_SERVICES_JSON_BASE64|PLAY_CONFIG_JSON|storePassword|keyPassword|keyAlias|storeFile)["\s]{0,32}[=:]')
    private_pem = re.compile(rb'-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\s]{16,32768}-----END \1-----')

    def possible_json(prefix):
        for encoding in ('utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be',
                         'utf-32', 'utf-32-le', 'utf-32-be'):
            try:
                # Prefixes can end inside a codepoint. Hold that trailing byte
                # sequence instead of misclassifying a valid JSON object as binary.
                first = codecs.getincrementaldecoder(encoding)().decode(prefix, final=False).lstrip()
                if not first or first.startswith(('{', '[')):
                    return True
            except UnicodeError:
                pass
        return False

    def scan(stream, collect_json=False):
        tail = b''
        collected = bytearray()
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            data = tail + chunk
            if any(value in data for value in needles) or assignments.search(data) or private_pem.search(data):
                raise ValidationError('runtime private input detected')
            tail = data[-tail_length:]
            if collect_json:
                collected.extend(chunk)
                if len(collected) > 16 * 1024 * 1024:
                    if possible_json(bytes(collected[:65536])):
                        raise ValidationError('runtime JSON audit size exceeded')
                    # Large binary entries still receive the full literal/PEM scan.
                    collect_json = False
                    collected.clear()
        if collect_json:
            try:
                value = json.loads(collected)
            except (ValueError, UnicodeError):
                return
            if isinstance(value, dict) and 'project_info' in value and 'client' in value:
                raise ValidationError('runtime raw Firebase configuration detected')

    try:
        if apk.is_symlink() or not apk.is_file():
            raise ValidationError('runtime APK input is not a regular file')
        with apk.open('rb') as stream:
            scan(stream)  # Includes ZIP names and the APK signing block.
        with zipfile.ZipFile(apk) as archive:
            seen = set()
            total = 0
            for info in archive.infolist():
                name = info.filename
                leaf = name.rsplit('/', 1)[-1].lower()
                total += info.file_size
                if (name in seen or info.flag_bits & 1 or '..' in name.split('/') or name.startswith('/')
                        or '\\' in name or (info.external_attr >> 16) & 0o170000 == 0o120000
                        or total > 1024 * 1024 * 1024 or info.file_size > 256 * 1024 * 1024
                        or leaf in ('google-services.json', 'signing.env', 'ponlet-cert.pem', '.env', 'ownership.json', 'credentials.json')
                        or leaf.endswith(('.jks', '.keystore', '.p12', '.pfx', '.key', '.p8', '.pk8', '.pkcs12'))):
                    raise ValidationError('runtime archive audit rejected')
                seen.add(name)
                with archive.open(info) as stream:
                    # JSON's byte parser handles BOM/UTF16/UTF32, renames, and
                    # arbitrary leading whitespace. Parse every bounded entry.
                    scan(stream, True)
    except ValidationError:
        raise
    except Exception:
        # Decompressors and ZIP parsers can raise other errors. No exception text
        # or private ZIP path may reach a runner traceback on an audit failure.
        raise ValidationError('runtime archive audit failed') from None
    return {'archive_private_input_scan_passed': True, 'password_literal_scan': 'all-lengths',
            'alias_literal_minimum_bytes': 16, 'short_alias_literal_scan': 'not-performed',
            'raw_and_expanded_archive_scan': True, 'raw_firebase_json_scan': True}


def export_runtime_apk(repo, runner_temp, apk, report, incoming, signing, firebase):
    return export_verified_artifact(repo, runner_temp, apk, report, incoming, signing, firebase, 'runtime')


def export_bundle_aab(repo, runner_temp, aab, report, incoming, signing, firebase):
    if not isinstance(report, dict) or report.get('verified') is not True:
        raise ValidationError('bundle verifier did not confirm success')
    return export_verified_artifact(repo, runner_temp, aab, report, incoming, signing, firebase, 'bundle')


def export_verified_artifact(repo, runner_temp, artifact, report, incoming, signing, firebase, mode):
    extension = EXPORT_ARTIFACTS[mode]
    artifacts = report.get('artifacts', [])
    if not isinstance(artifacts, list):
        raise ValidationError(mode + ' verified artifact report missing')
    entries = [a for a in artifacts if isinstance(a, dict) and a.get('type') == extension]
    if (len(entries) != 1 or not isinstance(entries[0].get('sha256'), str)
            or not re.fullmatch(r'[0-9a-f]{64}', entries[0]['sha256'])
            or (mode == 'bundle' and entries[0].get('verified') is not True)):
        raise ValidationError(mode + ' verified ' + extension.upper() + ' digest missing')
    if mode == 'runtime':
        audit = audit_runtime_apk(artifact, incoming, signing, firebase)
    elif artifact.is_symlink() or not artifact.is_file():
        raise ValidationError('bundle AAB input is not a regular file')
    directory = Path(runner_temp) / ('ponlet-' + mode + '-export')
    directory.mkdir(mode=0o700)  # Exclusive; never overwrite a pre-existing export.
    info = directory.stat()
    ownership = {'repo': str(repo.resolve()), 'device': info.st_dev, 'inode': info.st_ino}
    try:
        (directory / 'ownership.json').write_text(json.dumps(ownership))
        digest = hashlib.sha256()
        with artifact.open('rb') as source, (directory / 'export.tmp').open('xb') as destination:
            while chunk := source.read(65536):
                digest.update(chunk)
                destination.write(chunk)
        if digest.hexdigest() != entries[0]['sha256']:
            raise ValidationError(mode + ' ' + extension.upper() + ' differs from verified digest')
        if mode == 'bundle':
            # Audit the exact, digest-bound bytes that will be exported.
            audit = audit_runtime_apk(directory / 'export.tmp', incoming, signing, firebase)
        (directory / 'export.tmp').replace(directory / ('ponlet-release.' + extension))
        return audit
    except BaseException:
        # This process owns the inode even when marker writing was interrupted.
        remove_owned_export(repo, directory, ownership, mode)
        raise


def cleanup_owned(repo, runner_temp):
    export_error = False
    for mode in EXPORT_ARTIFACTS:
        try:
            cleanup_export(repo, runner_temp, mode)
        except (ValidationError, OSError, ValueError, TypeError):
            export_error = True  # Other exports and private-input fallback still run.
    allowed = {repo / 'apps/tauri/gen/android/app/google-services.json',
               repo / 'apps/tauri/gen/android/tauri.settings.gradle',
               repo / 'apps/tauri/gen/android/app/tauri.build.gradle.kts'}
    allowed = {str(path.resolve()) for path in allowed}
    for work in Path(runner_temp).glob('ponlet-signed-validation-*'):
        if work.is_symlink() or not work.is_dir():
            continue
        try:
            record = json.loads((work / 'ownership.json').read_text())
            if record.get('repo') != str(repo.resolve()):
                continue
            for entry in record.get('files', []):
                if entry.get('path') not in allowed:
                    continue
                path = Path(entry['path'])
                if path.is_symlink():
                    continue
                try:
                    info = path.stat()
                    if (info.st_dev, info.st_ino) == (entry.get('device'), entry.get('inode')):
                        path.unlink()
                except FileNotFoundError:
                    pass
            shutil.rmtree(work)
        except (OSError, ValueError, TypeError, AttributeError):
            # Never remove an original file or print an untrusted marker on uncertainty.
            raise ValidationError('owned cleanup could not be established')
    if export_error:
        raise ValidationError('owned export cleanup failed')


def validate(repo, expected, incoming):
    actual = source_guard(repo, expected, incoming)
    mode = incoming.get('VALIDATION_MODE', 'verify')
    if mode not in ('verify', 'runtime', 'bundle'):
        raise ValidationError('unsupported validation mode')
    if mode in EXPORT_ARTIFACTS:
        export = Path(incoming['RUNNER_TEMP']) / ('ponlet-' + mode + '-export')
        if export.exists() or export.is_symlink():
            raise ValidationError('existing ' + mode + ' export must remain untouched')
    if not all(incoming.get(key) for key in INPUT_KEYS):
        raise ValidationError('required signing or Firebase input missing')
    if incoming.get('PONLET_ANDROID_BUILD_ONLY'):
        raise ValidationError('unsigned build-only mode cannot validate signing/Firebase')
    app = repo / 'apps/tauri/gen/android/app'
    config = app / 'google-services.json'
    if config.exists():
        raise ValidationError('existing Firebase configuration must remain untouched')
    # Avoid ambient Play credentials even if a caller accidentally supplies them.
    base_env = {k: v for k, v in incoming.items()
                if k not in {*INPUT_KEYS, *DERIVED_KEYS, 'PLAY_CONFIG_JSON', 'GITHUB_ENV'}}
    old_mask = os.umask(0o077)
    created_config = False
    created_settings = False
    exported = False
    completed = False
    settings = app.parent / 'tauri.settings.gradle'
    try:
        with tempfile.TemporaryDirectory(prefix='ponlet-signed-validation-', dir=incoming['RUNNER_TEMP']) as temp:
            work = Path(temp)
            record_ownership(work, repo, [])
            metadata_file = work / 'cargo-metadata.json'
            run_private(['cargo', 'metadata', '--format-version', '1', '--locked',
                         '--filter-platform', 'aarch64-linux-android',
                         '--manifest-path', str(repo / 'apps/tauri/Cargo.toml')],
                        repo, base_env, work, 'cargo-metadata', json_output=metadata_file)
            prepare_tauri_settings(repo, json.loads(metadata_file.read_text()), settings)
            created_settings = True
            record_ownership(work, repo, [settings, app / 'tauri.build.gradle.kts'])
            private_env = work / 'signing.env'
            private_env.touch()
            helper_env = dict(base_env, RUNNER_TEMP=temp, GITHUB_ENV=str(private_env))
            helper_env.update({k: incoming[k] for k in SIGNING_KEYS})
            run_private(['bash', str(repo / 'scripts/setup_android_signing.sh')], repo,
                        helper_env, work, 'signing')
            signing = parse_private_env(private_env, work / 'ponlet-release.keystore')
            firebase = decode_firebase(incoming['GOOGLE_SERVICES_JSON_BASE64'])
            parsed = json.loads(firebase)
            if parsed.get('project_info', {}).get('project_id') != 'ponlet-599c4' or not any(
                    client.get('client_info', {}).get('android_client_info', {}).get('package_name') == 'jp.yasagure.ponlet'
                    for client in parsed.get('client', [])):
                raise ValidationError('Firebase project or package mismatch')
            # Exclusive creation prevents overwriting any caller-owned original file.
            with config.open('xb') as output:
                created_config = True
                output.write(firebase)
            record_ownership(work, repo, [settings, app / 'tauri.build.gradle.kts', config])
            gradle_home = work / 'gradle'
            init_dir = gradle_home / 'init.d'
            init_dir.mkdir(parents=True)
            init_source = repo / 'scripts/signed_android_no_upload.init.gradle'
            shutil.copyfile(init_source, init_dir / 'signed-validation.gradle')
            build_env = dict(base_env, **signing, GRADLE_USER_HOME=str(gradle_home),
                             PONLET_SIGNED_VALIDATION='1', PONLET_ANDROID_PROJECT_DIR=str(app.parent.resolve()),
                             PONLET_ANDROID_VERSION_CODE=VERSION_CODE,
                             CARGO_PROFILE_RELEASE_STRIP='none', GRADLE_OPTS=f'-Dgradle.user.home={gradle_home} -Dorg.gradle.daemon=false -Dorg.gradle.configuration-cache=false')
            # Discard old artifacts so a stale result cannot satisfy the gate.
            outputs = app / 'build/outputs'
            if outputs.exists():
                raise ValidationError('build outputs must be absent in the fresh CI checkout')
            digests = {}
            digests['graph'] = run_private(
                ['bash', str(app.parent / 'gradlew'), ':app:bundleUniversalRelease',
                 ':app:assembleUniversalRelease', '--dry-run', '--no-daemon',
                 '--no-configuration-cache', '--init-script', str(init_dir / 'signed-validation.gradle')],
                app.parent, build_env, work, 'gradle-graph', require_graph=True)
            for artifact in ('aab', 'apk'):
                build_env['PONLET_ANDROID_ARTIFACT'] = artifact
                digests[artifact] = run_private(
                    ['bash', str(repo / 'scripts/build_tauri_mobile.sh'), 'android', 'release'],
                    repo, build_env, work, 'build-' + artifact, require_graph=True)
            bundles = list(outputs.glob('bundle/**/*.aab'))
            apks = [p for p in outputs.glob('apk/**/*.apk') if 'unsigned' not in p.name]
            if len(bundles) != 1 or len(apks) != 1:
                raise ValidationError('expected exactly one signed AAB and APK')
            sdk = Path(base_env.get('ANDROID_HOME') or base_env.get('ANDROID_SDK_ROOT', ''))
            java = Path(base_env['JAVA_HOME']) / 'bin'
            safe_report = work / 'verification.json'
            verify_env = dict(base_env)  # No signing passwords/input/config env for verification.
            apksigner = find_tool(sdk, 'apksigner')
            tool_version = apksigner_version_diagnostic(apksigner)
            print(json.dumps(tool_version, sort_keys=True), file=sys.stderr)
            try:
                run_private([sys.executable, str(repo / 'scripts/verify_signed_android_release.py'),
                             str(bundles[0]), str(apks[0]), '--expect-version-code', VERSION_CODE,
                             '--apksigner', apksigner, '--jarsigner', str(java / 'jarsigner'),
                             '--keytool', str(java / 'keytool'), '--report', str(safe_report)],
                            repo, verify_env, work, 'artifact-verification')
            except ValidationError:
                publish_failure_report(safe_report)
                raise
            # The verifier owns the reviewed, secret-free report schema. Never echo tool output.
            report = json.loads(safe_report.read_text())
            if not isinstance(report, dict) or report.get('verified') is not True:
                raise ValidationError('artifact verifier did not confirm success')
            summary = {'source_sha': actual, 'version_code': int(VERSION_CODE),
                       'control_sha256': hashlib.sha256(init_source.read_bytes()).hexdigest(),
                       'build_log_sha256': digests, 'verification': report, **tool_version}
            if mode == 'runtime':
                try:
                    summary['runtime_export_audit'] = export_runtime_apk(
                        repo, incoming['RUNNER_TEMP'], apks[0], report, incoming, signing, firebase)
                except ValidationError:
                    print(json.dumps({'runtime_export_error': 'audit-or-digest-rejected'}), file=sys.stderr)
                    raise
                exported = True
            elif mode == 'bundle':
                try:
                    summary['bundle_export_audit'] = export_bundle_aab(
                        repo, incoming['RUNNER_TEMP'], bundles[0], report, incoming, signing, firebase)
                except ValidationError:
                    print(json.dumps({'bundle_export_error': 'audit-or-digest-rejected'}), file=sys.stderr)
                    raise
                exported = True
            rendered = json.dumps(summary, sort_keys=True, indent=2)
            print(rendered)
            if base_env.get('GITHUB_STEP_SUMMARY'):
                with open(base_env['GITHUB_STEP_SUMMARY'], 'a') as output:
                    output.write('### Signed Android build validation\n\n```json\n' + rendered + '\n```\n')
            completed = True
    finally:
        # Each owned-file cleanup is independent: an export or filesystem error
        # must not strand restored Firebase inputs or prevent umask restoration.
        cleanup_failed = False
        try:
            if exported and not completed:
                try:
                    cleanup_export(repo, incoming['RUNNER_TEMP'], mode)
                except (ValidationError, OSError, ValueError, TypeError):
                    cleanup_failed = True
            paths = ([config] if created_config else []) + (
                [settings, app / 'tauri.build.gradle.kts'] if created_settings else [])
            for path in paths:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    cleanup_failed = True
        finally:
            os.umask(old_mask)
        if cleanup_failed:
            raise ValidationError('owned final cleanup failed') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-request', action='store_true')
    parser.add_argument('--check-source', action='store_true')
    parser.add_argument('--cleanup-owned', action='store_true')
    parser.add_argument('--expected-source-sha', default=os.environ.get('EXPECTED_SOURCE_SHA', ''))
    args = parser.parse_args()
    def stop(_signum, _frame):
        raise ValidationError('cancelled')
    signal.signal(signal.SIGTERM, stop)
    try:
        if args.cleanup_owned:
            cleanup_owned(Path(__file__).resolve().parents[1], os.environ['RUNNER_TEMP'])
        elif args.check_request:
            debug_guard(dict(os.environ))
            request(os.environ.get('VALIDATION_MODE', ''), args.expected_source_sha,
                    os.environ.get('CONFIRM_DEPLOY', 'false'))
        elif args.check_source:
            source_guard(Path(__file__).resolve().parents[1], args.expected_source_sha, dict(os.environ))
        else:
            validate(Path(__file__).resolve().parents[1], args.expected_source_sha, dict(os.environ))
    except (ValidationError, OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('Signed validation stopped; no raw private output is exposed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
