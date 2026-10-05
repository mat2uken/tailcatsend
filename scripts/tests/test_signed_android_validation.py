import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('signed_validation', SCRIPTS / 'signed_android_validation.py')
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)
SHA = '5e0125797c2466918772a6722302d84219a1792a'


class GuardTests(unittest.TestCase):
    def test_unknown_modes_incomplete_source_and_unconfirmed_deploy_stop(self):
        validation.request('verify', SHA, 'false')
        validation.request('runtime', SHA, 'false')
        validation.request('bundle', SHA, 'false')
        validation.request('deploy', '', 'true')
        for mode, source, confirm in [('other', SHA, 'true'), ('', SHA, 'false'),
                                      ('verify', SHA[:8], 'false'), ('runtime', SHA[:8], 'false'), ('verify', SHA + '\n', 'false'),
                                      ('bundle', SHA[:8], 'false'), ('bundle', SHA.upper(), 'false'),
                                      ('bundle', SHA + '\n', 'false'),
                                      ('deploy', SHA, 'false'), ('deploy', SHA, 'TRUE')]:
            with self.assertRaises(validation.ValidationError):
                validation.request(mode, source, confirm)
        for key in ('ACTIONS_STEP_DEBUG', 'ACTIONS_RUNNER_DEBUG', 'RUNNER_DEBUG'):
            with self.assertRaises(validation.ValidationError):
                validation.debug_guard({key: 'true'})
        with self.assertRaises(validation.ValidationError):
            validation.debug_guard({'RUNNER_DEBUG': '1'})

    def test_private_environment_is_literal_and_rejects_extra_duplicate_or_wrong_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / 'env'
            key = Path(tmp) / 'key'
            safe = f'PONLET_ANDROID_KEYSTORE={key}\nANDROID_KEYSTORE_PASSWORD=$(touch injected)\nANDROID_KEY_ALIAS=alias\nANDROID_KEY_PASSWORD=pass\n'
            env.write_text(safe)
            self.assertEqual(validation.parse_private_env(env, key)['ANDROID_KEYSTORE_PASSWORD'], '$(touch injected)')
            for content in (safe + 'PLAY_CONFIG_JSON=evil\n', safe + 'ANDROID_KEY_ALIAS=again\n',
                            safe.replace(str(key), '/unexpected/key'), safe.replace('alias\n', 'alias\nINJECT=x\n')):
                env.write_text(content)
                with self.assertRaises(validation.ValidationError):
                    validation.parse_private_env(env, key)

    def test_failed_command_and_missing_graph_never_echo_private_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            captured = io.StringIO()
            for exit_code, require_graph in [(1, False), (0, True)]:
                with contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                    validation.run_private(['python3', '-c', f'print("PRIVATE_SENTINEL"); exit({exit_code})'],
                                           tmp, dict(os.environ), Path(tmp), 'fixture', require_graph)
            self.assertNotIn('PRIVATE_SENTINEL', captured.getvalue())
            events = [json.loads(line) for line in captured.getvalue().splitlines()]
            failures = [event for event in events if event['status'] == 'failed']
            self.assertEqual([event['return_code'] for event in failures], [1, 0])
            self.assertEqual([event['category'] for event in failures], ['unclassified', 'graph-marker-missing'])
            self.assertTrue(all('elapsed_seconds' in event and 'log_sha256' in event for event in failures))

    def test_failure_classifier_emits_fixed_enums_without_log_fragments(self):
        fixtures = [(b'PRIVATE_SENTINEL unknown error', 1, 'unclassified'),
                    (b'PRIVATE_SENTINEL No space left on device', 1, 'disk-space'),
                    (b'PRIVATE_SENTINEL java heap space', 1, 'memory'),
                    (b'PRIVATE_SENTINEL daemon disappeared', 1, 'gradle-daemon'),
                    (b'PRIVATE_SENTINEL Formatting issues found', 1, 'frontend-check'),
                    (b'PRIVATE_SENTINEL Cannot apply patch cleanly', 1, 'patches'),
                    (b'PRIVATE_SENTINEL unknown error', -9, 'process-killed')]
        for content, code, expected in fixtures:
            self.assertEqual(validation.failure_category(content, code), expected)
        with tempfile.TemporaryDirectory() as tmp:
            captured = io.StringIO()
            with contextlib.redirect_stderr(captured):
                validation.phase_event('build-apk', 'failed', tmp, validation.time.monotonic(),
                                       137, 'process-killed', 'a' * 64)
            event = json.loads(captured.getvalue())
            self.assertEqual(event['return_code'], 137)
            self.assertEqual(event['category'], 'process-killed')
            self.assertTrue(isinstance(event['disk_free_bytes'], int))
            self.assertNotIn(tmp, captured.getvalue())
            self.assertNotIn('PRIVATE_SENTINEL', captured.getvalue())
            self.assertLessEqual(set(event), {'validation_phase', 'status', 'elapsed_seconds', 'return_code',
                                              'category', 'log_sha256', 'disk_free_bytes', 'memory_available_bytes'})


    def test_base64_wrapping_is_accepted_but_invalid_chars_are_rejected(self):
        encoded = base64.b64encode(b'{"fixture": true}').decode()
        wrapped = ' \t' + encoded[:8] + '\r\n' + encoded[8:] + '\n'
        self.assertEqual(validation.decode_firebase(wrapped), b'{"fixture": true}')
        for bad in (encoded + '!', encoded + '\v', encoded + '非ASCII'):
            with self.assertRaises(ValueError):
                validation.decode_firebase(bad)

    def test_fallback_cleanup_removes_only_owned_inodes_and_private_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'repo'
            app = repo / 'apps/tauri/gen/android/app'
            app.mkdir(parents=True)
            config = app / 'google-services.json'
            config.write_text('OWNED_FIXTURE')
            original = app.parent / 'tauri.settings.gradle'
            original.write_text('ORIGINAL_UNOWNED')
            runner = Path(tmp) / 'runner'
            work = runner / 'ponlet-signed-validation-fixture'
            work.mkdir(parents=True)
            (work / 'secret.log').write_text('PRIVATE_FIXTURE')
            validation.record_ownership(work, repo, [config])
            validation.cleanup_owned(repo, runner)
            self.assertFalse(config.exists())
            self.assertFalse(work.exists())
            self.assertEqual(original.read_text(), 'ORIGINAL_UNOWNED')

    def test_failed_report_exposes_only_reviewed_enum_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'safe.json'
            report.write_text(json.dumps({'errors': ['PRIVATE_SENTINEL', 'signature_tool_failed'],
                                           'artifacts': [{'errors': ['artifact_validation_failed', 'secret=abc']}]}))
            self.assertEqual(validation.report_error_codes(report),
                             ['artifact_validation_failed', 'signature_tool_failed'])
            report.write_text('malformed PRIVATE_SENTINEL')
            self.assertEqual(validation.report_error_codes(report), [])

    def test_signature_counts_publish_only_exact_fields_and_bounded_integers(self):
        good = dict(zip(validation.SIGNATURE_DIAGNOSTIC_FIELDS, (0, 128, 1, 2) * 3))
        self.assertEqual(len(good), 12)
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'safe.json'
            report.write_text(json.dumps({'errors': ['PRIVATE_LABEL', 'signature_tool_failed'],
                                           'raw_path': '/PRIVATE_PATH', 'certificate': 'PRIVATE_CERT',
                                           'artifacts': [{'type': 'apk', 'signature_diagnostics': good}]}))
            captured = io.StringIO()
            with contextlib.redirect_stderr(captured):
                validation.publish_failure_report(report)
            self.assertEqual(json.loads(captured.getvalue()),
                             {'artifact_error_codes': ['signature_tool_failed'], 'signature_diagnostics': good})
            self.assertNotIn('PRIVATE_', captured.getvalue())
            for key in validation.SIGNATURE_DIAGNOSTIC_FIELDS:
                for bad in (True, False, -1, 129, 1.0, '1', None, {'raw_label': 'PRIVATE_LABEL'}, ['PRIVATE_CERT']):
                    invalid = dict(good, **{key: bad})
                    report.write_text(json.dumps({'artifacts': [{'type': 'apk', 'signature_diagnostics': invalid}]}))
                    captured = io.StringIO()
                    with contextlib.redirect_stderr(captured):
                        validation.publish_failure_report(report)
                    self.assertEqual(captured.getvalue(), '')
            for invalid in (dict(good, raw_label='PRIVATE_LABEL'),
                            dict(good, path='/PRIVATE_PATH'), dict(good, certificate='PRIVATE_CERT'),
                            {key: value for key, value in good.items() if key != 'numbered_lines'},
                            dict(list(good.items())[:4]),
                            'PRIVATE_CERT', None, []):
                report.write_text(json.dumps({'artifacts': [{'type': 'apk', 'signature_diagnostics': invalid}]}))
                self.assertIsNone(validation.report_signature_diagnostics(report))
            for artifacts in ([{'type': 'PRIVATE_LABEL', 'signature_diagnostics': good}],
                              [{'type': 'aab', 'signature_diagnostics': good}],
                              [{'type': 'apk', 'signature_diagnostics': good}] * 2):
                report.write_text(json.dumps({'artifacts': artifacts}))
                self.assertIsNone(validation.report_signature_diagnostics(report))

    def test_apksigner_version_has_only_strict_numeric_parts_or_unknown_boolean(self):
        for label, numbers in [('35.0.0', [35, 0, 0]), ('1.2.3', [1, 2, 3]),
                               ('999.123.456', [999, 123, 456]), ('001.002.003', [1, 2, 3])]:
            value = validation.apksigner_version_diagnostic('/PRIVATE_PATH/' + label + '/apksigner')
            self.assertEqual(value, {'apksigner_build_tools_version': numbers})
            self.assertTrue(all(type(number) is int for number in value['apksigner_build_tools_version']))
            self.assertNotIn('PRIVATE_PATH', json.dumps(value))
            self.assertNotIn(label, json.dumps(value))
        for label in ('PRIVATE_CERT', '35.0.0-rc1', '35.0', '1000.0.0', '35.0.0\n',
                      '３５.0.0', '+35.0.0', '35.0.0 PRIVATE_LABEL'):
            value = validation.apksigner_version_diagnostic('/PRIVATE_PATH/' + label + '/apksigner')
            self.assertEqual(value, {'apksigner_build_tools_version_known': False})
            self.assertNotIn('PRIVATE_', json.dumps(value))
            self.assertNotIn(label, json.dumps(value))

    def test_cancellation_terminates_private_child_process_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(subprocess, 'Popen') as popen, patch.object(os, 'killpg') as kill:
                popen.return_value.pid = 123456
                popen.return_value.wait.side_effect = [validation.ValidationError('cancelled'), 0]
                with self.assertRaises(validation.ValidationError):
                    validation.run_private(['fixture'], tmp, {}, Path(tmp), 'cancelled')
                kill.assert_called_once_with(123456, validation.signal.SIGTERM)
                self.assertTrue(popen.call_args.kwargs['start_new_session'])


class OpaqueBuildTests(unittest.TestCase):
    def fixture(self, root, fail=False):
        scripts = root / 'scripts'
        scripts.mkdir()
        app = root / 'apps/tauri/gen/android/app'
        app.mkdir(parents=True)
        (scripts / 'signed_android_no_upload.init.gradle').write_text((SCRIPTS / 'signed_android_no_upload.init.gradle').read_text())
        # Synthetic signing fixture only: no keytool, actual keystore or credentials.
        (scripts / 'setup_android_signing.sh').write_text('''#!/bin/bash
set -eu
printf 'NOT_A_REAL_KEY' > "$RUNNER_TEMP/ponlet-release.keystore"
printf 'PONLET_ANDROID_KEYSTORE=%s\nANDROID_KEYSTORE_PASSWORD=%s\nANDROID_KEY_ALIAS=%s\nANDROID_KEY_PASSWORD=%s\n' "$RUNNER_TEMP/ponlet-release.keystore" "$ANDROID_KEYSTORE_PASSWORD" "$ANDROID_KEY_ALIAS" "$ANDROID_KEY_PASSWORD" >> "$GITHUB_ENV"
echo PRIVATE_SIGNING_SENTINEL
''')
        (scripts / 'build_tauri_mobile.sh').write_text('''#!/bin/bash
set -eu
for key in ANDROID_KEYSTORE_BASE64 GOOGLE_SERVICES_JSON_BASE64 PLAY_CONFIG_JSON GITHUB_ENV; do
  test -z "${!key+x}"
done
test "$PONLET_ANDROID_VERSION_CODE" = 2030000102
test "$PONLET_SIGNED_VALIDATION" = 1
test -f "$GRADLE_USER_HOME/init.d/signed-validation.gradle"
test -f "$PONLET_ANDROID_KEYSTORE"
echo PRIVATE_BUILD_SENTINEL
echo PONLET_SIGNED_VALIDATION_GRAPH_OK
''' + ('exit 9\n' if fail else '''if [ "$PONLET_ANDROID_ARTIFACT" = aab ]; then
  mkdir -p apps/tauri/gen/android/app/build/outputs/bundle/universalRelease
  echo FIXTURE > apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/app.aab
else
  mkdir -p apps/tauri/gen/android/app/build/outputs/apk/universal/release
  echo FIXTURE > apps/tauri/gen/android/app/build/outputs/apk/universal/release/app.apk
fi
'''))
        (scripts / 'verify_signed_android_release.py').write_text('''import json, os, sys
for key in ('ANDROID_KEYSTORE_BASE64','GOOGLE_SERVICES_JSON_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD','PONLET_ANDROID_KEYSTORE','GITHUB_ENV','PLAY_CONFIG_JSON'):
    assert key not in os.environ
from pathlib import Path
Path(sys.argv[sys.argv.index('--report') + 1]).write_text(json.dumps({'verified': True}))
print('PRIVATE_VERIFIER_SENTINEL')
''')
        (root / 'apps/tauri/Cargo.toml').write_text('[dependencies]\ntauri = "2"\ntauri-plugin-fixture = "2"\n')
        tauri = root / 'crate-tauri'
        plugin = root / 'crate-plugin'
        (tauri / 'mobile/android').mkdir(parents=True)
        (plugin / 'android').mkdir(parents=True)
        generator = root / 'crate-tauri-build'
        (generator / 'src').mkdir(parents=True)
        (generator / 'src/mobile.rs').write_text('androidx.lifecycle:lifecycle-process:2.10.0')
        metadata = {'packages': [{'name': 'tauri', 'manifest_path': str(tauri / 'Cargo.toml')},
                                 {'name': 'tauri-plugin-fixture', 'manifest_path': str(plugin / 'Cargo.toml')},
                                 {'name': 'tauri-build', 'manifest_path': str(generator / 'Cargo.toml')}]}
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        cargo = bin_dir / 'cargo'
        cargo.write_text('#!/usr/bin/env python3\nimport os\nassert "ANDROID_KEYSTORE_PASSWORD" not in os.environ\nassert "ANDROID_KEYSTORE_BASE64" not in os.environ\nprint(' + repr(json.dumps(metadata)) + ')\n')
        cargo.chmod(0o755)
        (app.parent / 'gradlew').write_text('''#!/bin/bash
set -eu
test "$1" = :app:bundleUniversalRelease
test "$2" = :app:assembleUniversalRelease
test "$3" = --dry-run
test -f tauri.settings.gradle
echo PRIVATE_GRAPH_SENTINEL
echo PONLET_SIGNED_VALIDATION_GRAPH_OK
''')
        temp = root / 'runner-temp'
        temp.mkdir()
        sdk = root / 'sdk/build-tools/35.0.0'
        sdk.mkdir(parents=True)
        (sdk / 'apksigner').touch()
        global_env = root / 'job.env'
        global_env.write_text('UNCHANGED=1\n')
        firebase = {'project_info': {'project_id': 'ponlet-599c4'}, 'client': [{'client_info': {'android_client_info': {'package_name': 'jp.yasagure.ponlet'}}}]}
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], RUNNER_TEMP=str(temp), JAVA_HOME=str(root / 'jdk'),
                   ANDROID_HOME=str(root / 'sdk'), GITHUB_ENV=str(global_env),
                   PLAY_CONFIG_JSON='AMBIENT_PLAY_SENTINEL',
                   GOOGLE_SERVICES_JSON_BASE64=base64.b64encode(json.dumps(firebase).encode()).decode())
        env.update({key: 'TEST_ONLY_INPUT' for key in validation.SIGNING_KEYS})
        return app, env, global_env, temp

    def test_success_uses_opaque_credentials_without_job_env_or_log_leak(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root)
            captured = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA + '\n'), contextlib.redirect_stdout(captured):
                validation.validate(root, SHA, env)
            for token in ('PRIVATE_', 'TEST_ONLY_INPUT', 'AMBIENT_PLAY_SENTINEL'):
                self.assertNotIn(token, captured.getvalue())
            self.assertEqual(json.loads(captured.getvalue())['version_code'], 2030000102)
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.iterdir()), [])

    def test_failed_build_cleans_inputs_and_private_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root, fail=True)
            env['VALIDATION_MODE'] = 'runtime'
            captured = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA + '\n'), contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                validation.validate(root, SHA, env)
            self.assertNotIn('PRIVATE_', captured.getvalue())
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.iterdir()), [])
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')

    def test_artifact_failure_publishes_numeric_counts_without_private_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root)
            counts = dict(zip(validation.SIGNATURE_DIAGNOSTIC_FIELDS, (0, 2, 0, 1) + (0,) * 8))
            env['VALIDATION_MODE'] = 'runtime'
            report = {'verified': False, 'errors': [], 'raw_path': '/PRIVATE_PATH',
                      'artifacts': [{'type': 'apk', 'errors': ['apk_public_certificate_missing_or_ambiguous'],
                                     'signature_diagnostics': counts, 'raw_label': 'PRIVATE_LABEL',
                                     'certificate': 'PRIVATE_CERT'}]}
            (root / 'scripts/verify_signed_android_release.py').write_text(
                'import sys\nfrom pathlib import Path\n'
                'Path(sys.argv[sys.argv.index("--report") + 1]).write_text(' + repr(json.dumps(report)) + ')\n'
                'print("PRIVATE_TOOL_OUTPUT")\nraise SystemExit(1)\n')
            captured = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                validation.validate(root, SHA, env)
            events = [json.loads(line) for line in captured.getvalue().splitlines()]
            diagnostics = [event for event in events if 'signature_diagnostics' in event]
            self.assertEqual(diagnostics, [{'artifact_error_codes': ['apk_public_certificate_missing_or_ambiguous'],
                                           'signature_diagnostics': counts}])
            self.assertIn({'apksigner_build_tools_version': [35, 0, 0]}, events)
            self.assertNotIn('PRIVATE_', captured.getvalue())
            self.assertNotIn('TEST_ONLY_INPUT', captured.getvalue())
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.iterdir()), [])
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')

    def test_failed_preflight_graph_stops_before_either_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            (app.parent / 'gradlew').write_text('echo PRIVATE_GRAPH_FAILURE; exit 9')
            with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(validation.ValidationError):
                validation.validate(root, SHA, env)
            self.assertFalse((app / 'build/outputs').exists())
            self.assertFalse((app / 'google-services.json').exists())
            self.assertFalse((app / 'tauri.build.gradle.kts').exists())
            self.assertFalse((app.parent / 'tauri.settings.gradle').exists())
            self.assertEqual(list(temp.iterdir()), [])

    def test_tracked_plugin_metadata_missing_duplicate_and_existing_files_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, _, _, _ = self.fixture(root)
            settings = app.parent / 'tauri.settings.gradle'
            metadata = {'packages': [{'name': name, 'manifest_path': str(root / directory / 'Cargo.toml')}
                                     for name, directory in [('tauri', 'crate-tauri'),
                                                             ('tauri-plugin-fixture', 'crate-plugin'),
                                                             ('tauri-build', 'crate-tauri-build')]]}
            for packages in (metadata['packages'][:-1], metadata['packages'] + [metadata['packages'][0]]):
                with self.assertRaises(validation.ValidationError):
                    validation.prepare_tauri_settings(root, {'packages': packages}, settings)
                self.assertFalse(settings.exists())
                self.assertFalse((app / 'tauri.build.gradle.kts').exists())
            validation.prepare_tauri_settings(root, metadata, settings)
            original = settings.read_text()
            self.assertEqual(original.count("include ':tauri-android'"), 1)
            self.assertIn('lifecycle-process:2.10.0', (app / 'tauri.build.gradle.kts').read_text())
            with self.assertRaises(validation.ValidationError):
                validation.prepare_tauri_settings(root, metadata, settings)
            self.assertEqual(settings.read_text(), original)

    def test_stale_source_and_existing_config_fail_before_signing_or_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            config = app / 'google-services.json'
            config.write_text('ORIGINAL_CONFIG')
            for head in ('0' * 40, SHA):
                with patch.object(subprocess, 'check_output', return_value=head), self.assertRaises(validation.ValidationError):
                    validation.validate(root, SHA, env)
                self.assertEqual(config.read_text(), 'ORIGINAL_CONFIG')
                self.assertEqual(list(temp.iterdir()), [])

    def test_validation_job_has_no_deployment_or_publication_steps(self):
        # Pure source check complements execution fixtures; no YAML dependency required.
        workflow = (SCRIPTS.parent / '.github/workflows/google_play.yml').read_text()
        job = workflow.split('  signed-validation:', 1)[1].split('  build-and-deploy:', 1)[0]
        for forbidden in ('PLAY_CONFIG_JSON', 'upload-google-play', 'cache: npm',
                          'cache-dependency-path', 'gh release', 'setup_android_signing.sh'):
            self.assertNotIn(forbidden, job)
        self.assertIn('cache: false', job)
        self.assertIn('persist-credentials: false', job)
        self.assertIn("inputs.mode == 'verify'", job)
        self.assertIn("inputs.confirm_deploy == true", workflow)
        self.assertIn('default: verify', workflow)
        self.assertEqual(job.count('uses: actions/upload-artifact@v4'), 1)
        self.assertIn("if: success() && inputs.mode == 'runtime'", job)
        self.assertIn('path: ${{ runner.temp }}/ponlet-runtime-export/ponlet-release.apk', job)
        self.assertIn('retention-days: 1', job)
        self.assertIn('if-no-files-found: error', job)
        self.assertIn('if: always()', job)
        init = (SCRIPTS / 'signed_android_no_upload.init.gradle').read_text()
        self.assertIn('gradle.taskGraph.whenReady', init)
        self.assertIn('blocked(it) && it.enabled', init)
        self.assertIn('mappingFileUploadEnabled = false', init)
        self.assertIn('nativeSymbolUploadEnabled = false', init)

    def test_runtime_exports_only_digest_bound_apk_after_private_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root)
            env['VALIDATION_MODE'] = 'runtime'
            script = root / 'scripts/build_tauri_mobile.sh'
            content = script.read_text().replace(
                'echo FIXTURE > apps/tauri/gen/android/app/build/outputs/apk/universal/release/app.apk',
                "python3 -c \"import zipfile; z=zipfile.ZipFile('apps/tauri/gen/android/app/build/outputs/apk/universal/release/app.apk','w'); z.writestr('resources.arsc',b'compiled Firebase ponlet-599c4'); z.close()\"")
            script.write_text(content)
            (root / 'scripts/verify_signed_android_release.py').write_text(
                "import sys,json,hashlib\nfrom pathlib import Path\n"
                "Path(sys.argv[sys.argv.index('--report')+1]).write_text(json.dumps({'verified':True,'artifacts':[{'type':'apk','sha256':hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest()}]}))\n")
            captured = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stdout(captured), contextlib.redirect_stderr(io.StringIO()):
                validation.validate(root, SHA, env)
            export = temp / 'ponlet-runtime-export'
            self.assertEqual({p.name for p in export.iterdir()}, {'ponlet-release.apk', 'ownership.json'})
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.glob('ponlet-signed-validation-*')), [])
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')
            self.assertNotIn('TEST_ONLY_INPUT', captured.getvalue())
            self.assertTrue(json.loads(captured.getvalue())['runtime_export_audit']['archive_private_input_scan_passed'])
            validation.cleanup_owned(root, temp)
            self.assertEqual(list(temp.iterdir()), [])

    def test_summary_and_export_cleanup_failure_still_remove_inputs_and_restore_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            env.update(VALIDATION_MODE='runtime', GITHUB_STEP_SUMMARY=str(root))  # Directory: controlled write failure.
            original_umask = os.umask(0o077)
            os.umask(original_umask)
            captured = io.StringIO()
            try:
                with patch.object(subprocess, 'check_output', return_value=SHA), \
                        patch.object(validation, 'export_runtime_apk', return_value={'fixture': True}), \
                        patch.object(validation, 'cleanup_export', side_effect=validation.ValidationError('FIXTURE')), \
                        contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured), \
                        self.assertRaises(validation.ValidationError):
                    validation.validate(root, SHA, env)
                self.assertFalse((app / 'google-services.json').exists())
                self.assertFalse((app / 'tauri.build.gradle.kts').exists())
                self.assertFalse((app.parent / 'tauri.settings.gradle').exists())
                self.assertEqual(list(temp.iterdir()), [])
                observed = os.umask(original_umask)
                self.assertEqual(observed, original_umask)
                self.assertNotIn('TEST_ONLY_INPUT', captured.getvalue())
            finally:
                os.umask(original_umask)


class BundleBuildTests(unittest.TestCase):
    def fixture(self, root, payload=b'compiled Firebase ponlet-599c4', digest=None):
        app, env, global_env, temp = OpaqueBuildTests().fixture(root)
        env['VALIDATION_MODE'] = 'bundle'
        script = root / 'scripts/build_tauri_mobile.sh'
        builder = root / 'scripts/fixture_bundle.py'
        builder.write_text("import zipfile\nwith zipfile.ZipFile(" +
                           repr(str(app / 'build/outputs/bundle/universalRelease/app.aab')) +
                           ", 'w', zipfile.ZIP_DEFLATED) as archive:\n"
                           "    archive.writestr('base/resources.pb', " + repr(payload) + ")\n")
        script.write_text(script.read_text().replace(
            'echo FIXTURE > apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/app.aab',
            'python3 scripts/fixture_bundle.py'))
        (root / 'scripts/verify_signed_android_release.py').write_text(
            "import sys,json,hashlib,os\nfrom pathlib import Path\n"
            "assert not any(k in os.environ for k in ('ANDROID_KEYSTORE_BASE64', 'GOOGLE_SERVICES_JSON_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'PONLET_ANDROID_KEYSTORE', 'GITHUB_ENV', 'PLAY_CONFIG_JSON'))\n"
            "assert Path(sys.argv[1]).suffix == '.aab' and Path(sys.argv[2]).suffix == '.apk'\n"
            "digest = " + (repr(digest) if digest is not None else "hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()") + "\n"
            "Path(sys.argv[sys.argv.index('--report')+1]).write_text(json.dumps({'verified':True,'artifacts':[{'type':'aab','verified':True,'sha256':digest},{'type':'apk','verified':True,'sha256':hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest()}]}))\n"
            "print('PRIVATE_VERIFIER_SENTINEL')\n")
        return app, env, global_env, temp

    def test_bundle_exports_only_verified_aab_and_cleans_private_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, global_env, temp = self.fixture(root)
            captured = io.StringIO()
            diagnostics = io.StringIO()
            with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stdout(captured), contextlib.redirect_stderr(diagnostics):
                validation.validate(root, SHA, env)
            export = temp / 'ponlet-bundle-export'
            self.assertEqual({p.name for p in export.iterdir()}, {'ponlet-release.aab', 'ownership.json'})
            report = json.loads(captured.getvalue())
            self.assertTrue(report['bundle_export_audit']['archive_private_input_scan_passed'])
            entry = next(a for a in report['verification']['artifacts'] if a['type'] == 'aab')
            self.assertEqual(entry['sha256'], hashlib.sha256((export / 'ponlet-release.aab').read_bytes()).hexdigest())
            self.assertEqual(report['source_sha'], SHA)
            self.assertEqual(report['version_code'], 2030000102)
            self.assertFalse((temp / 'ponlet-runtime-export').exists())
            self.assertFalse((app / 'google-services.json').exists())
            self.assertFalse((app / 'tauri.build.gradle.kts').exists())
            self.assertFalse((app.parent / 'tauri.settings.gradle').exists())
            self.assertEqual(list(temp.glob('ponlet-signed-validation-*')), [])
            self.assertEqual(global_env.read_text(), 'UNCHANGED=1\n')
            for token in ('PRIVATE_', 'TEST_ONLY_INPUT', 'AMBIENT_PLAY_SENTINEL'):
                self.assertNotIn(token, captured.getvalue() + diagnostics.getvalue())
            validation.cleanup_owned(root, temp)
            self.assertEqual(list(temp.iterdir()), [])

    def test_bundle_audit_and_digest_failures_never_publish_summary_or_export(self):
        for payload, digest in ((b'TEST_ONLY_INPUT', None), (b'harmless', '0' * 64)):
            with self.subTest(digest=digest), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                app, env, _, temp = self.fixture(root, payload, digest)
                captured, diagnostics = io.StringIO(), io.StringIO()
                with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stdout(captured), contextlib.redirect_stderr(diagnostics), self.assertRaises(validation.ValidationError):
                    validation.validate(root, SHA, env)
                self.assertEqual(captured.getvalue(), '')
                self.assertIn('"bundle_export_error": "audit-or-digest-rejected"', diagnostics.getvalue())
                for token in ('PRIVATE_', 'TEST_ONLY_INPUT', '0' * 64, 'bundle_export_audit'):
                    self.assertNotIn(token, diagnostics.getvalue())
                self.assertFalse((app / 'google-services.json').exists())
                self.assertEqual(list(temp.iterdir()), [])

    def test_missing_or_ambiguous_built_aab_stops_before_verifier(self):
        for suffix in ('rm apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/app.aab\n',
                       'cp apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/app.aab apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/second.aab\n'):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                app, env, _, temp = self.fixture(root)
                builder = root / 'scripts/build_tauri_mobile.sh'
                builder.write_text(builder.read_text() + 'if [ "$PONLET_ANDROID_ARTIFACT" = apk ]; then\n' + suffix + 'fi\n')
                captured = io.StringIO()
                with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                    validation.validate(root, SHA, env)
                self.assertNotIn('artifact-verification', captured.getvalue())
                self.assertNotIn('PRIVATE_', captured.getvalue())
                self.assertFalse((app / 'google-services.json').exists())
                self.assertEqual(list(temp.iterdir()), [])

    def test_existing_bundle_export_stops_before_signing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            export = temp / 'ponlet-bundle-export'
            export.mkdir()
            original = export / 'original'
            original.write_text('UNOWNED')
            with patch.object(subprocess, 'check_output', return_value=SHA), self.assertRaises(validation.ValidationError):
                validation.validate(root, SHA, env)
            self.assertEqual(original.read_text(), 'UNOWNED')
            self.assertFalse((app / 'google-services.json').exists())
            self.assertFalse((app / 'build').exists())

    def test_summary_write_failure_removes_completed_bundle_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, env, _, temp = self.fixture(root)
            env['GITHUB_STEP_SUMMARY'] = str(root)
            with patch.object(subprocess, 'check_output', return_value=SHA), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(OSError):
                validation.validate(root, SHA, env)
            self.assertFalse((app / 'google-services.json').exists())
            self.assertEqual(list(temp.iterdir()), [])


class RuntimeAuditTests(unittest.TestCase):
    def fixture(self, root):
        key = root / 'fixture.keystore'
        key.write_bytes(b'FAKE_PRIVATE_KEYSTORE_CONTENT')
        signing = {'PONLET_ANDROID_KEYSTORE': str(key), 'ANDROID_KEYSTORE_PASSWORD': 'password-sentinel',
                   'ANDROID_KEY_PASSWORD': 'key-password-sentinel', 'ANDROID_KEY_ALIAS': 'ponlet'}
        firebase = b'{"project_info":{"project_id":"fixture"},"client":[]}'
        incoming = {'ANDROID_KEYSTORE_BASE64': base64.b64encode(key.read_bytes()).decode(),
                    'GOOGLE_SERVICES_JSON_BASE64': base64.b64encode(firebase).decode()}
        return signing, firebase, incoming

    def test_compiled_client_public_certificate_and_pem_constants_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming = self.fixture(root)
            apk = root / 'app.apk'
            with zipfile.ZipFile(apk, 'w') as z:
                z.writestr('resources.arsc', b'ponlet fixture compiled API key')
                z.writestr('META-INF/CERT.RSA', b'PUBLIC_DER_CERTIFICATE')
                z.writestr('lib/arm64-v8a/crypto.so', b'-----BEGIN PRIVATE KEY-----\x00-----END PRIVATE KEY-----')
            result = validation.audit_runtime_apk(apk, incoming, signing, firebase)
            self.assertEqual(result['short_alias_literal_scan'], 'not-performed')

    def test_raw_or_compressed_private_inputs_names_json_and_pem_rejected_silently(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming = self.fixture(root)
            cases = [('payload.bin', signing['ANDROID_KEYSTORE_PASSWORD'].encode()),
                     ('payload.bin', incoming['ANDROID_KEYSTORE_BASE64'].encode()),
                     ('payload.bin', incoming['GOOGLE_SERVICES_JSON_BASE64'].encode()),
                     ('payload.bin', (root / 'fixture.keystore').read_bytes()),
                     ('payload.bin', firebase), ('renamed.bin', b'{ "client": [], "project_info": {} }'),
                     ('renamed.bin', b' ' * 70000 + b'{ "client": [], "project_info": {} }'),
                     ('renamed.bin', b'\xef\xbb\xbf' + b'{ "client": [], "project_info": {} }'),
                     ('renamed.bin', '{ "client": [], "project_info": {} }'.encode('utf-16')),
                     ('renamed.bin', '{ "client": [], "project_info": {} }'.encode('utf-16-be')),
                     ('google-services.json', b'{}'), ('private.jks', b'{}'),
                     ('signing.env', b'{}'), ('ponlet-cert.pem', b'PUBLIC'),
                     ('payload.bin', b'ANDROID_KEY_PASSWORD = hidden'),
                     ('payload.bin', b'{"storePassword": "hidden"}'),
                     ('payload.bin', b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 64 + b'\n-----END PRIVATE KEY-----'),
                     ('payload.bin', b'x' * 65530 + signing['ANDROID_KEY_PASSWORD'].encode()),
                     ('password-sentinel/file', b'harmless')]
            for name, data in cases:
                apk = root / 'app.apk'
                with zipfile.ZipFile(apk, 'w', zipfile.ZIP_DEFLATED) as z:
                    z.writestr(name, data)
                captured = io.StringIO()
                with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                    validation.audit_runtime_apk(apk, incoming, signing, firebase)
                self.assertEqual(captured.getvalue(), '')

    def test_corrupt_duplicate_archive_and_digest_mismatch_never_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming = self.fixture(root)
            apk = root / 'app.apk'
            apk.write_bytes(b'not an APK')
            with self.assertRaises(validation.ValidationError):
                validation.audit_runtime_apk(apk, incoming, signing, firebase)

            with zipfile.ZipFile(apk, 'w') as z:
                z.writestr('safe', b'safe')
            with self.assertRaises(validation.ValidationError):
                validation.export_runtime_apk(root, root, apk, {'artifacts': [{'type': 'apk', 'sha256': '0' * 64}]}, incoming, signing, firebase)
            self.assertFalse((root / 'ponlet-runtime-export').exists())
            with zipfile.ZipFile(apk, 'a') as z:
                with unittest.mock.patch('warnings.warn'):
                    z.writestr('safe', b'again')
            with self.assertRaises(validation.ValidationError):
                validation.audit_runtime_apk(apk, incoming, signing, firebase)

    def test_encrypted_crc_invalid_and_unknown_parser_errors_fail_without_raw_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming = self.fixture(root)
            apk = root / 'app.apk'
            with zipfile.ZipFile(apk, 'w') as z:
                z.writestr('safe', b'CRC_FIXTURE_CONTENT')
            original = apk.read_bytes()
            encrypted = bytearray(original)
            for header, offset in ((b'PK\x03\x04', 6), (b'PK\x01\x02', 8)):
                index = encrypted.index(header) + offset
                encrypted[index] |= 1
            corrupt = original.replace(b'CRC_FIXTURE_CONTENT', b'CRC_FIXTURE_CORRUPT')
            for data in (bytes(encrypted), corrupt):
                apk.write_bytes(data)
                with self.assertRaises(validation.ValidationError):
                    validation.audit_runtime_apk(apk, incoming, signing, firebase)
            apk.write_bytes(original)
            with patch.object(validation.zipfile, 'ZipFile', side_effect=Exception('PRIVATE_PARSER_SECRET')):
                with self.assertRaises(validation.ValidationError) as caught:
                    validation.audit_runtime_apk(apk, incoming, signing, firebase)
                self.assertNotIn('PRIVATE', str(caught.exception))

    def test_wrapped_inputs_long_alias_and_short_password_are_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming = self.fixture(root)
            compact = incoming['ANDROID_KEYSTORE_BASE64']
            incoming['ANDROID_KEYSTORE_BASE64'] = ' \t' + compact[:10] + '\r\n' + compact[10:]
            signing['ANDROID_KEY_ALIAS'] = 'LONG_ALIAS_SENTINEL_16'
            signing['ANDROID_KEY_PASSWORD'] = 'xy'
            apk = root / 'app.apk'
            for payload in (compact.encode(), incoming['ANDROID_KEYSTORE_BASE64'].encode(),
                            signing['ANDROID_KEY_ALIAS'].encode(), b'xy'):
                with zipfile.ZipFile(apk, 'w', zipfile.ZIP_DEFLATED) as z:
                    z.writestr('payload', payload)
                with self.assertRaises(validation.ValidationError):
                    validation.audit_runtime_apk(apk, incoming, signing, firebase)

    def test_cleanup_preserves_unowned_directory_and_removes_owned_cancelled_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / 'ponlet-runtime-export'
            directory.mkdir()
            (directory / 'original').write_text('original')
            validation.cleanup_export(root, root)
            self.assertEqual((directory / 'original').read_text(), 'original')
            (directory / 'original').unlink()
            stat = directory.stat()
            (directory / 'ownership.json').write_text(json.dumps({'repo': str(root.resolve()), 'device': stat.st_dev, 'inode': stat.st_ino}))
            (directory / 'export.tmp').write_text('cancelled')
            validation.cleanup_export(root, root)
            self.assertFalse(directory.exists())

    def test_bad_export_marker_cannot_skip_private_input_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / 'apps/tauri/gen/android/app'
            app.mkdir(parents=True)
            config = app / 'google-services.json'
            config.write_text('PRIVATE_CONFIG_FIXTURE')
            private = root / 'ponlet-signed-validation-fixture'
            private.mkdir()
            (private / 'private.log').write_text('PRIVATE_LOG_FIXTURE')
            validation.record_ownership(private, root, [config])
            export = root / 'ponlet-runtime-export'
            export.mkdir()
            (export / 'ownership.json').write_text('malformed')
            with self.assertRaises(validation.ValidationError):
                validation.cleanup_owned(root, root)
            self.assertFalse(config.exists())
            self.assertFalse(private.exists())
            self.assertTrue(export.exists())

    def test_large_utf32be_json_and_split_utf8_prefix_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming = self.fixture(root)
            apk = root / 'app.apk'
            cases = [
                (' ' * (17 * 1024 * 1024) + '{"project_info":{},"client":[]}').encode('utf-32-be'),
                b'{"x":"' + b'a' * (65535 - 6) + 'あ'.encode() + b'a' * (17 * 1024 * 1024)
                + b'","project_info":{},"client":[]}',
            ]
            self.assertEqual(cases[1][65535:65536], 'あ'.encode()[:1])
            for data in cases:
                self.assertIn('project_info', json.loads(data))  # Valid client-config shaped JSON.
                with zipfile.ZipFile(apk, 'w', zipfile.ZIP_DEFLATED) as z:
                    z.writestr('renamed.bin', data)
                with self.assertRaises(validation.ValidationError):
                    validation.audit_runtime_apk(apk, incoming, signing, firebase)


class BundleExportTests(unittest.TestCase):
    def fixture(self, root):
        signing, firebase, incoming = RuntimeAuditTests().fixture(root)
        aab = root / 'app.aab'
        with zipfile.ZipFile(aab, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('base/resources.pb', b'compiled public Firebase configuration')
            archive.writestr('META-INF/CERT.RSA', b'PUBLIC_CERTIFICATE')
        report = {'verified': True, 'artifacts': [
            {'type': 'aab', 'verified': True, 'sha256': hashlib.sha256(aab.read_bytes()).hexdigest()},
            {'type': 'apk', 'verified': True, 'sha256': '1' * 64}]}
        return signing, firebase, incoming, aab, report

    def test_missing_duplicate_wrong_type_unverified_and_invalid_aab_reports_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming, aab, report = self.fixture(root)
            entry = report['artifacts'][0]
            invalid = [None, [], {}, dict(report, verified=False), dict(report, verified=1)]
            invalid.extend(dict(report, artifacts=artifacts) for artifacts in
                           (None, {}, [], [report['artifacts'][1]], [entry, entry],
                            [dict(entry, type='AAB')], [dict(entry, verified=False)],
                            [dict(entry, verified=1)], [dict(entry, sha256='PRIVATE_DIGEST')],
                            [dict(entry, sha256='a' * 63)], [dict(entry, sha256='A' * 64)],
                            [dict(entry, sha256='a' * 64 + '\n')]))
            for bad in invalid:
                captured = io.StringIO()
                with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured), self.assertRaises(validation.ValidationError):
                    validation.export_bundle_aab(root, root, aab, bad, incoming, signing, firebase)
                self.assertEqual(captured.getvalue(), '')
                self.assertFalse((root / 'ponlet-bundle-export').exists())

    def test_audit_uses_copied_digest_bound_aab_and_exports_no_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming, aab, report = self.fixture(root)
            with patch.object(validation, 'audit_runtime_apk', wraps=validation.audit_runtime_apk) as audit:
                validation.export_bundle_aab(root, root, aab, report, incoming, signing, firebase)
            audit.assert_called_once_with(root / 'ponlet-bundle-export/export.tmp', incoming, signing, firebase)
            directory = root / 'ponlet-bundle-export'
            self.assertEqual({p.name for p in directory.iterdir()}, {'ponlet-release.aab', 'ownership.json'})
            self.assertEqual((directory / 'ponlet-release.aab').read_bytes(), aab.read_bytes())
            validation.cleanup_export(root, root, 'bundle')
            self.assertFalse(directory.exists())

    def test_failed_marker_and_cancelled_copy_remove_only_owned_export(self):
        for stage in ('marker', 'copy'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                signing, firebase, incoming, aab, report = self.fixture(root)
                unrelated = root / 'ponlet-bundle-export-unrelated'
                unrelated.mkdir()
                (unrelated / 'original').write_text('UNOWNED')
                original_write = Path.write_text
                original_open = Path.open

                def interrupted_write(path, content, *args, **kwargs):
                    if path.name == 'ownership.json':
                        original_write(path, '{')
                        raise KeyboardInterrupt()
                    return original_write(path, content, *args, **kwargs)

                def interrupted_open(path, *args, **kwargs):
                    if path.name == 'export.tmp':
                        raise KeyboardInterrupt()
                    return original_open(path, *args, **kwargs)

                target, replacement = ('write_text', interrupted_write) if stage == 'marker' else ('open', interrupted_open)
                with patch.object(Path, target, replacement), self.assertRaises(KeyboardInterrupt):
                    validation.export_bundle_aab(root, root, aab, report, incoming, signing, firebase)
                self.assertFalse((root / 'ponlet-bundle-export').exists())
                self.assertEqual((unrelated / 'original').read_text(), 'UNOWNED')

    def test_bundle_cleanup_preserves_unowned_files_and_cleans_other_owned_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing, firebase, incoming, aab, report = self.fixture(root)
            unowned = root / 'ponlet-runtime-export'
            unowned.mkdir()
            (unowned / 'original').write_text('UNOWNED')
            validation.export_bundle_aab(root, root, aab, report, incoming, signing, firebase)
            validation.cleanup_owned(root, root)
            self.assertFalse((root / 'ponlet-bundle-export').exists())
            self.assertEqual((unowned / 'original').read_text(), 'UNOWNED')

            app = root / 'apps/tauri/gen/android/app'
            app.mkdir(parents=True)
            config = app / 'google-services.json'
            config.write_text('PRIVATE_CONFIG_FIXTURE')
            private = root / 'ponlet-signed-validation-fixture'
            private.mkdir()
            validation.record_ownership(private, root, [config])
            export = root / 'ponlet-bundle-export'
            export.mkdir()
            (export / 'ownership.json').write_text('malformed')
            with self.assertRaises(validation.ValidationError):
                validation.cleanup_owned(root, root)
            self.assertFalse(config.exists())
            self.assertFalse(private.exists())
            self.assertTrue(export.exists())
            self.assertEqual((unowned / 'original').read_text(), 'UNOWNED')


if __name__ == '__main__':
    unittest.main()
