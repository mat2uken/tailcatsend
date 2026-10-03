"""Exercise the checked-in patch against the pinned, unmodified submodule files.

All application and mutation happens in a temporary Git fixture. No compilation,
checkout reset, source submodule edits, network, or signing is performed.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
PATCH = '0001-android-selinux-netmon-fallback.patch'
FILES = ('tailcat.go', 'tailcat_test.go')


class TailcatPatchIdempotenceTests(unittest.TestCase):
    def test_forward_and_reverse_checks_keep_repeated_helper_bytes_unchanged(self):
        with tempfile.TemporaryDirectory(prefix='ponlet-patch-test-') as tmp:
            root = Path(tmp)
            checkout = root / 'tailcat/pkg/tailcat'
            checkout.mkdir(parents=True)
            (root / 'tailcat/pkg/tailscale.com').mkdir()
            (root / 'tailcat/patches').mkdir()
            (root / 'scripts').mkdir()
            original = {}
            for name in FILES:
                # Read committed data, even when the user's existing checkout is patched.
                original[name] = subprocess.check_output(
                    ['git', 'show', 'HEAD:' + name], cwd=REPO / 'tailcat/pkg/tailcat')
                (checkout / name).write_bytes(original[name])
            patch = root / 'tailcat/patches' / PATCH
            shutil.copyfile(REPO / 'tailcat/patches' / PATCH, patch)
            helper = root / 'scripts/apply_tailcat_patches.sh'
            shutil.copyfile(REPO / 'scripts/apply_tailcat_patches.sh', helper)
            subprocess.run(['git', 'init', '-q', str(checkout)], check=True, capture_output=True)

            # Both Git checks must succeed; invoking the portable fallback is a regression.
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            fallback_marker = root / 'fallback-used'
            fallback = bin_dir / 'patch'
            fallback.write_text('#!/bin/sh\n: > "$PATCH_FALLBACK_MARKER"\nexit 99\n')
            fallback.chmod(0o755)
            env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                       PATCH_FALLBACK_MARKER=str(fallback_marker))
            forward = subprocess.run(['git', 'apply', '--check', '--unidiff-zero', str(patch)],
                                     cwd=checkout, capture_output=True, text=True)
            self.assertEqual(forward.returncode, 0, forward.stderr)
            first = subprocess.run(['bash', str(helper)], env=env, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertIn('Applied ' + PATCH, first.stdout)
            applied = {name: (checkout / name).read_bytes() for name in FILES}
            self.assertTrue(all(applied[name] != original[name] for name in FILES))
            # Preserve every intended Android change and the peer-status regression check.
            self.assertEqual(applied['tailcat.go'].count(b'for i := 0; err == nil && i < 40'), 2)
            self.assertIn(b'netMon.InjectEvent()', applied['tailcat.go'])
            self.assertIn(b'c.lb.sys.NetMon.Get().InjectEvent()', applied['tailcat.go'])
            self.assertIn(b'sb.AddPeer(k, &ipnstate.PeerStatus{TailscaleIPs: ips})', applied['tailcat.go'])
            self.assertEqual(applied['tailcat_test.go'].count(b'\t"slices"\n'), 1)
            self.assertIn(b'!slices.Equal(ps.TailscaleIPs, want)', applied['tailcat_test.go'])
            reverse = subprocess.run(['git', 'apply', '--reverse', '--check', '--unidiff-zero', str(patch)],
                                     cwd=checkout, capture_output=True, text=True)
            self.assertEqual(reverse.returncode, 0, reverse.stderr)
            second = subprocess.run(['bash', str(helper)], env=env, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn('Already applied ' + PATCH, second.stdout)
            for name in FILES:
                repeated = (checkout / name).read_bytes()
                self.assertEqual(repeated, applied[name])
                self.assertEqual(hashlib.sha256(repeated).digest(), hashlib.sha256(applied[name]).digest())
            self.assertFalse(fallback_marker.exists())


if __name__ == '__main__':
    unittest.main()
