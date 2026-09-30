import os
from pathlib import Path
import subprocess
import unittest
ROOT=Path(__file__).resolve().parents[2]
class GuardTests(unittest.TestCase):
 def test_archive_requires_hosted_runner_before_build(self):
  r=subprocess.run(['bash',str(ROOT/'scripts/build_macos_archive_ci.sh')],env={'PATH':os.environ['PATH']},capture_output=True,text=True)
  self.assertEqual(r.returncode,2);self.assertIn('GitHub-hosted',r.stderr)
 def test_mac_export_requires_explicit_owner_confirmation(self):
  r=subprocess.run(['bash',str(ROOT/'scripts/export_macos_archive_on_mac.sh'),str(ROOT),'a'*40,'b'*64,'unused-output'],env={'PATH':os.environ['PATH']},capture_output=True,text=True)
  self.assertEqual(r.returncode,2);self.assertIn('confirm',r.stderr)
if __name__=='__main__':unittest.main()
