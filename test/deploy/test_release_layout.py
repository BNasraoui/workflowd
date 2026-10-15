"""Layout and pruning checks use only disposable directories, never live paths."""
import fcntl
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_verified_deploy import d


class ReleaseLayoutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.checkout = self.root / 'deploy/current'
        self.checkout.parent.mkdir(mode=0o755)
        self.releases = self.checkout.parent / 'releases'
        self.releases.mkdir(mode=0o700)
        self.current = self.releases / 'active'
        self.previous = self.releases / 'older'
        self.unused = self.releases / 'unused'
        for release in [self.current, self.previous, self.unused]:
            release.mkdir()
            (release / 'keep').write_text('release contents')
        self.checkout.symlink_to(self.current)
        (self.checkout.parent / 'previous').symlink_to(self.previous)
        self.state = self.root / 'operator/last-deployed'
        self.state.parent.mkdir(mode=0o700)

    def test_private_releases_and_direct_current_are_accepted(self):
        self.assertEqual(d.release_layout(self.checkout), (self.releases, self.current))

    def test_releases_with_group_or_other_access_are_refused(self):
        for mode in [0o750, 0o705, 0o770]:
            with self.subTest(mode=mode):
                self.releases.chmod(mode)
                with self.assertRaisesRegex(ValueError, 'private operator-owned'):
                    d.release_layout(self.checkout)

    def test_releases_symlink_is_refused(self):
        moved = self.root / 'elsewhere'
        self.releases.rename(moved)
        self.releases.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'private operator-owned'):
            d.release_layout(self.checkout)

    def test_current_outside_releases_is_refused(self):
        self.checkout.unlink()
        self.checkout.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'retained release'):
            d.release_layout(self.checkout)

    def test_prune_removes_only_named_unused_release_under_lock(self):
        real_rmtree = d.shutil.rmtree

        def remove(path):
            with d.append_file(self.state.parent / 'verified-deploy.lock') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            real_rmtree(path)

        with patch.object(d.shutil, 'rmtree', side_effect=remove):
            d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertFalse(self.unused.exists())
        self.assertTrue((self.current / 'keep').exists())
        self.assertTrue((self.previous / 'keep').exists())

    def test_prune_validates_whole_request_before_deleting(self):
        for protected in ['active', 'older', '../deploy', '.', str(self.current), 'missing']:
            with self.subTest(protected=protected), self.assertRaises((ValueError, OSError)):
                d.prune_releases(self.checkout, self.state, ['unused', protected])
            self.assertTrue(self.unused.exists())
            self.assertTrue(self.current.exists())
            self.assertTrue(self.previous.exists())

    def test_prune_refuses_symlinks_and_unresolved_previous(self):
        (self.releases / 'alias').symlink_to(self.unused)
        with self.assertRaises(ValueError):
            d.prune_releases(self.checkout, self.state, ['alias'])
        previous = self.checkout.parent / 'previous'
        previous.unlink()
        previous.symlink_to(self.root / 'absent')
        with self.assertRaises((ValueError, OSError)):
            d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertTrue(self.unused.exists())

    def test_prune_refuses_while_deploy_lock_is_held(self):
        with d.append_file(self.state.parent / 'verified-deploy.lock') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertTrue(self.unused.exists())

    def test_prune_cli_uses_fixed_state_without_deploy_credentials(self):
        argv = ['verified-deploy.py', '--checkout', str(self.checkout), '--prune', 'unused']
        with patch.object(d, 'DEPLOY_STATE', self.state), patch.object(d.sys, 'argv', argv):
            d.main()
        self.assertFalse(self.unused.exists())
        self.assertTrue(self.current.exists())
