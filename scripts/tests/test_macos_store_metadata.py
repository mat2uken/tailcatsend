import datetime as dt
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('metadata',Path(__file__).parents[1]/'macos_store_metadata.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MetadataTests(unittest.TestCase):
    def test_number_limits_and_no_wrap(self):
        self.assertEqual(m.build_number(123,2),'1123.0.2')
        self.assertEqual(m.build_number(8999,99),'9999.0.99')
        for run,attempt in [(0,1),(9000,1),(1,100)]:
            with self.assertRaises(ValueError):m.build_number(run,attempt)
        for value in ['1.0.19.1','01.0.1','1.100.1','x;echo bad','1.0.-1','10000.0.1']:
            with self.assertRaises(ValueError):m.build_number(1,1,value)
    def test_numeric_comparison_cli(self):
        import subprocess, sys
        script=str(Path(__file__).parents[1]/'macos_store_metadata.py')
        for candidate,previous,valid in [('1001.0.1','1.0.19',True),('2.0.1','2.0.1',False),('1.10.0','1.9.99',True),('2.0.1','1001.0.1',False)]:
            result=subprocess.run([sys.executable,script,'compare',candidate,previous],capture_output=True)
            self.assertEqual(result.returncode==0,valid)
    def test_set_number_preserves_ios_and_changes_both_mac_targets(self):
        import subprocess, sys, tempfile
        script=Path(__file__).parents[1]/'macos_store_metadata.py'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); target=root/'apps/tauri/gen/apple/project.yml'
            target.parent.mkdir(parents=True)
            original=(script.parents[1]/'apps/tauri/gen/apple/project.yml').read_text()
            target.write_text(original)
            subprocess.run([sys.executable,str(script.resolve()),'set-number','1001.0.1'],cwd=root,check=True)
            self.assertEqual(target.read_text().count('CFBundleVersion: "1001.0.1"'),2)
            self.assertEqual(original.split('  tailsend-tauri_macOS:',1)[0],target.read_text().split('  tailsend-tauri_macOS:',1)[0])
    def profile(self):
        return dict(TeamIdentifier=[m.TEAM],Platform=['OSX'],UUID='12345678-1234-1234-1234-123456789abc',ExpirationDate=dt.datetime.now()+dt.timedelta(days=1),DeveloperCertificates=[b'cert'],Entitlements={'com.apple.application-identifier':m.TEAM+'.'+m.IDS[0],'com.apple.developer.team-identifier':m.TEAM,'com.apple.security.application-groups':[m.GROUP]})
    def test_profile_valid_and_rejects_development(self):
        p=self.profile();fp=m.hashlib.sha1(b'cert').hexdigest()
        self.assertEqual(m.profile_check(p,m.IDS[0],fp),p['UUID'])
        for key,value in [('ProvisionedDevices',['device']),('ProvisionsAllDevices',True),('Platform',['iOS']),('ExpirationDate',dt.datetime.now()-dt.timedelta(days=1))]:
            p=self.profile();p[key]=value
            with self.assertRaises(AssertionError):m.profile_check(p,m.IDS[0],fp)
        for key,value in [('com.apple.security.get-task-allow',True),('com.apple.security.application-groups',[]),('com.apple.application-identifier',m.TEAM+'.other')]:
            p=self.profile();p['Entitlements'][key]=value
            with self.assertRaises(AssertionError):m.profile_check(p,m.IDS[0],fp)
        with self.assertRaises(AssertionError):m.profile_check(self.profile(),m.IDS[0],'wrong')

if __name__=='__main__':unittest.main()
