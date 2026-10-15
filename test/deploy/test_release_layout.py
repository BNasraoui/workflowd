"""Layout and pruning checks use only disposable directories, never live paths."""
import fcntl
import os
from pathlib import Path
import subprocess
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
        self.proc = self.root / 'proc'
        self.proc.mkdir()
        self.enterContext(patch.object(d, 'PROC_ROOT', self.proc, create=True))
        self.unit_properties = {}
        self.enterContext(patch.object(d, 'command', side_effect=self.systemctl))

    def systemctl(self, *args):
        self.assertEqual(args[:-1], ('systemctl', '--user', 'show', '-p', 'MainPID',
                                    '-p', 'ExecStart', '-p', 'WorkingDirectory'))
        self.assertIn(args[-1], d.UNITS)
        with d.append_file(self.state.parent / 'verified-deploy.lock') as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        properties = dict(MainPID='0', ExecStart='', WorkingDirectory='/')
        properties.update(self.unit_properties.get(args[-1], {}))
        return '\n'.join(f'{key}={value}' for key, value in properties.items())

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

    def test_prune_cli_refuses_each_deploy_argument_without_deleting(self):
        options = [[str(self.current)], ['--skills', str(self.root / 'skills')],
                   ['--github-token-file', str(self.root / 'token')],
                   ['--approval-app-id', '123'], ['--approval-app-id', '0'],
                   ['--bun', str(self.root / 'bun')], ['--bootstrap']]
        for option in options:
            argv = ['verified-deploy.py', *option, '--checkout', str(self.checkout),
                    '--prune', 'unused']
            with self.subTest(option=option), patch.object(d, 'DEPLOY_STATE', self.state), \
                 patch.object(d.sys, 'argv', argv):
                with self.assertRaisesRegex(ValueError, 'Prune cannot be combined'):
                    d.main()
            self.assertTrue(self.unused.exists())

    def test_prune_does_not_create_missing_releases(self):
        checkout = self.root / 'typo/current'
        checkout.parent.mkdir()
        with self.assertRaises((ValueError, OSError)):
            d.prune_releases(checkout, self.state, ['unused'])
        self.assertFalse((checkout.parent / 'releases').exists())

    def test_prune_refuses_unit_paths_in_any_candidate_before_deleting(self):
        spare = self.releases / 'spare'
        spare.mkdir()
        alias = self.root / 'alias'
        alias.symlink_to(self.unused)
        for unit in d.UNITS:
            for properties in [dict(WorkingDirectory=str(alias)),
                               dict(ExecStart=f'{{ path={alias}/bun ; argv[]={alias}/bun ; }}'),
                               dict(ExecStart=f'{{ path=/bin/bun ; argv[]=/bin/bun {alias}/main.ts ; }}')]:
                with self.subTest(unit=unit, properties=properties):
                    self.unit_properties = {unit: properties}
                    with self.assertRaisesRegex(ValueError, 'in use'):
                        d.prune_releases(self.checkout, self.state, ['spare', 'unused'])
                    self.assertTrue(self.unused.exists())
                    self.assertTrue(spare.exists())

    def test_prune_refuses_process_cwd_exe_and_root(self):
        process = self.proc / '123'
        process.mkdir()
        for name in ['cwd', 'exe', 'root']:
            link = process / name
            link.symlink_to(self.unused / 'keep')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'in use'):
                d.prune_releases(self.checkout, self.state, ['unused'])
            self.assertTrue(self.unused.exists())
            link.unlink()

    def test_prune_checks_unit_main_pid_even_if_owned_by_another_user(self):
        process = self.proc / '123'
        process.mkdir()
        (process / 'cwd').symlink_to(self.unused)
        self.unit_properties = {d.UNITS[-1]: dict(MainPID='123')}
        # The operator scan must skip this simulated foreign UID, but MainPID must not.
        with patch.object(d.os, 'geteuid', return_value=os.geteuid() + 1), \
             patch.object(d, 'require_state_directory'), \
             patch.object(d, 'release_layout', return_value=(self.releases, self.current)):
            with self.assertRaisesRegex(ValueError, 'in use'):
                d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertTrue(self.unused.exists())

    def test_prune_refuses_a_real_process_working_in_the_candidate(self):
        with subprocess.Popen(['/bin/sleep', '60'], cwd=self.unused) as process:
            try:
                # Expose only this test child, never unrelated host processes.
                (self.proc / str(process.pid)).symlink_to(f'/proc/{process.pid}')
                with self.assertRaisesRegex(ValueError, 'in use'):
                    d.prune_releases(self.checkout, self.state, ['unused'])
                self.assertEqual(Path(f'/proc/{process.pid}/cwd').resolve(), self.unused)
            finally:
                process.terminate()

    def test_prune_refuses_when_systemd_cannot_be_inspected(self):
        with patch.object(d, 'command', side_effect=subprocess.CalledProcessError(1, 'systemctl')):
            with self.assertRaises(subprocess.CalledProcessError):
                d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertTrue(self.unused.exists())

    def test_prune_refuses_when_operator_process_paths_are_unreadable(self):
        (self.proc / '123').mkdir()
        real_readlink = os.readlink

        def readlink(path):
            if Path(path).is_relative_to(self.proc):
                raise PermissionError('cannot inspect process')
            return real_readlink(path)

        with patch.object(d.os, 'readlink', side_effect=readlink):
            with self.assertRaises(PermissionError):
                d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertTrue(self.unused.exists())

    def test_prune_ignores_exited_processes_and_paths_in_sibling_releases(self):
        (self.proc / '123').symlink_to(self.root / 'exited-process')
        process = self.proc / '456'
        process.mkdir()
        sibling = self.releases / 'unused-but-different'
        sibling.mkdir()
        (process / 'cwd').symlink_to(sibling)
        self.unit_properties = {d.UNITS[0]: dict(WorkingDirectory=str(sibling))}
        d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertFalse(self.unused.exists())
        self.assertTrue(sibling.exists())

    def test_prune_resolves_exec_start_paths_containing_spaces(self):
        alias = self.root / 'path with spaces'
        alias.symlink_to(self.unused)
        for path in [str(alias), str(alias).replace(' ', r'\x20')]:
            self.unit_properties = {d.UNITS[0]: dict(
                ExecStart=f'{{ path=/bin/bun ; argv[]=/bin/bun {path}/main.ts ; }}')}
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'in use'):
                d.prune_releases(self.checkout, self.state, ['unused'])
