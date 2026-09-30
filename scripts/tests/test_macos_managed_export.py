"""Credential-free managed-export input and authorization tests."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import zipfile

SCRIPTS=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('managed_input',SCRIPTS/'verify_macos_managed_input.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SHA='a'*40

class ManagedExportTests(unittest.TestCase):
    def make_input(self, root, member=None, link=None):
        (root/'build-input.json').write_text(json.dumps(dict(commit=SHA,input_dirty=False,version='1.0.18',build='1001.0.1')))
        (root/'executable-code-sha256.json').write_text('{}')
        for filename,prefix in [('Ponlet-preflight.xcarchive.zip','Ponlet-preflight.xcarchive'),('Ponlet-local-sandbox.zip','Ponlet.app')]:
            with zipfile.ZipFile(root/filename,'w') as z:
                z.writestr(prefix+'/Contents/Info.plist','fixture')
                if filename.startswith('Ponlet-preflight') and member:
                    if link:
                        entry=zipfile.ZipInfo(member);entry.create_system=3;entry.external_attr=(stat.S_IFLNK|0o777)<<16
                        z.writestr(entry,link)
                    else:z.writestr(member,'fixture')
        files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}
        (root/'SHA256.json').write_text(json.dumps(files))
        return files['Ponlet-preflight.xcarchive.zip']
    def test_valid_reviewed_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);digest=self.make_input(root)
            self.assertEqual(m.verify(root,SHA,digest)['build'],'1001.0.1')
    def test_commit_checksum_dirty_and_missing_expected_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);digest=self.make_input(root)
            for commit,hashvalue in [('b'*40,digest),(SHA,'b'*64),('',digest)]:
                with self.assertRaises(ValueError):m.verify(root,commit,hashvalue)
            (root/'build-input.json').write_text(json.dumps(dict(commit=SHA,input_dirty=True)))
            with self.assertRaises(ValueError):m.verify(root,SHA,digest)
    def test_zip_traversal_and_symlink_escape_rejected(self):
        for member,link in [('../private',None),('/private',None),('Ponlet-preflight.xcarchive/Contents/link','../../../private'),('Ponlet-preflight.xcarchive','other')]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);digest=self.make_input(root,member,link)
                with self.assertRaises(ValueError):m.verify(root,SHA,digest)
    def test_failure_after_p8_creation_removes_private_scratch(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);scripts=root/'scripts';scripts.mkdir()
            for name in ('export_macos_managed_ci.sh','verify_macos_managed_input.py'):
                shutil.copy2(SCRIPTS/name,scripts/name)
            inputs=root/'inputs';inputs.mkdir();digest=self.make_input(inputs)
            bindir=root/'bin';bindir.mkdir();uname=bindir/'uname'
            uname.write_text('#!/bin/sh\necho arm64\n');uname.chmod(0o755)
            ditto=bindir/'ditto';ditto.write_text('#!/bin/sh\nexit 1\n');ditto.chmod(0o755)
            env={'PATH':str(bindir)+':'+os.environ['PATH'],'AUTHORIZE_CLOUD_SIGNING':'true','GITHUB_ACTIONS':'true','RUNNER_TEMP':str(root),'APP_STORE_CONNECT_PRIVATE_KEY':'-----BEGIN PRIVATE KEY-----\nnon-sensitive-fixture\n-----END PRIVATE KEY-----','APP_STORE_CONNECT_KEY_ID':'fixture','APP_STORE_CONNECT_ISSUER_ID':'fixture','EXPECTED_SOURCE_COMMIT':SHA,'EXPECTED_ARCHIVE_SHA256':digest}
            result=subprocess.run(['bash',str(scripts/'export_macos_managed_ci.sh'),str(inputs)],env=env,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn('non-sensitive-fixture',result.stdout+result.stderr)
            self.assertEqual(list(root.glob('ponlet-managed.*')),[])
    def test_authorization_and_secrets_fail_before_credential_access(self):
        script=SCRIPTS/'export_macos_managed_ci.sh'
        env={'PATH':os.environ['PATH']}
        result=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,2)
        self.assertIn('authorization is required',result.stderr)
        env['AUTHORIZE_CLOUD_SIGNING']='true'
        result=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,2)
        self.assertIn('Required secret is missing: APP_STORE_CONNECT_PRIVATE_KEY',result.stderr)

if __name__=='__main__':unittest.main()
