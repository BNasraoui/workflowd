"""Consumer inspection uses scratch releases, fake systemctl and isolated child PIDs."""
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_release_layout as fixtures
from test_verified_deploy import d


class PruneConsumerTests(unittest.TestCase):
    setUp = fixtures.ReleaseLayoutTests.setUp
    systemctl = fixtures.ReleaseLayoutTests.systemctl

    def test_systemd_working_directory_forms(self):
        for value in ['!' + str(self.unused), '~', '!~', 'relative/path', '!relative']:
            self.unused.mkdir(exist_ok=True)
            with self.subTest(value=value), patch.object(Path, 'home', return_value=self.unused):
                self.unit_properties = {d.UNITS[0]: dict(WorkingDirectory=value)}
                with self.assertRaises(ValueError):
                    d.prune_releases(self.checkout, self.state, ['unused'])
                self.assertTrue(self.unused.exists())

    def test_quoted_exec_paths_and_other_lifecycle_commands(self):
        alias = self.root / 'path with spaces'
        alias.symlink_to(self.unused)
        for prop in ['ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop',
                     'ExecStopPost', 'ExecReload']:
            for quote in ['"', "'"]:
                self.unused.mkdir(exist_ok=True)
                with self.subTest(prop=prop, quote=quote):
                    self.unit_properties = {d.UNITS[0]: {
                        prop: f'{{ path=/bin/sh ; argv[]=/bin/sh -c exec bun {quote}{alias}/x.ts{quote} ; }}'}}
                    with self.assertRaisesRegex(ValueError, 'in use'):
                        d.prune_releases(self.checkout, self.state, ['unused'])
                    self.assertTrue(self.unused.exists())

    def test_environment_path_entries(self):
        for value in [f'PATH=/usr/bin:{self.unused}/bin:/bin',
                      f'"PATH=/usr/bin:{self.unused}/bin:/bin" OTHER=value']:
            self.unused.mkdir(exist_ok=True)
            with self.subTest(value=value):
                self.unit_properties = {d.UNITS[0]: dict(Environment=value)}
                with self.assertRaisesRegex(ValueError, 'in use'):
                    d.prune_releases(self.checkout, self.state, ['unused'])

    def test_cgroup_descendant_process_cannot_be_acknowledged(self):
        cgroups = self.root / 'cgroups'
        nested = cgroups / 'workflowd/child'
        nested.mkdir(parents=True)
        (nested.parent / 'cgroup.procs').write_text('')
        (nested / 'cgroup.procs').write_text('123\n')
        process = self.proc / '123'
        process.mkdir()
        (process / 'cwd').symlink_to(self.unused)
        self.unit_properties = {d.UNITS[-1]: dict(ControlGroup='/workflowd')}
        with patch.object(d, 'CGROUP_ROOT', cgroups, create=True):
            with self.assertRaisesRegex(ValueError, 'in use'):
                d.prune_releases(self.checkout, self.state, ['unused'])
            (process / 'cwd').unlink()
            real_readlink = os.readlink

            def readlink(path):
                if Path(path).is_relative_to(self.proc):
                    raise PermissionError('unreadable')
                return real_readlink(path)

            with patch.object(d.os, 'readlink', side_effect=readlink):
                with self.assertRaises(PermissionError):
                    d.prune_releases(self.checkout, self.state, ['unused'],
                                     allow_unreadable={123})
        self.assertTrue(self.unused.exists())

    def test_unreadable_cgroup_membership_refuses(self):
        self.unit_properties = {d.UNITS[0]: dict(ControlGroup='/missing')}
        with patch.object(d, 'CGROUP_ROOT', self.root, create=True):
            with self.assertRaises(OSError):
                d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertTrue(self.unused.exists())

    def test_real_nondumpable_child_requires_explicit_acknowledgement(self):
        script = """import ctypes, sys
assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0
print('ready', flush=True)
sys.stdin.read()
"""
        with subprocess.Popen([sys.executable, '-c', script], cwd=self.root,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                (self.proc / str(child.pid)).symlink_to(f'/proc/{child.pid}')
                with self.assertRaises(PermissionError):
                    os.readlink(f'/proc/{child.pid}/cwd')
                output = io.StringIO()
                with patch.object(d.sys, 'stderr', output):
                    with self.assertRaisesRegex(ValueError, 'allow-unreadable'):
                        d.prune_releases(self.checkout, self.state, ['unused'])
                self.assertTrue(self.unused.exists())
                self.assertIn(str(child.pid), output.getvalue())
                self.assertIn(Path(f'/proc/{child.pid}/comm').read_text().strip(), output.getvalue())
                self.assertIn(repr(Path(f'/proc/{child.pid}/cgroup').read_text().strip()), output.getvalue())

                # Acknowledgement never exempts a unit's MainPID or cgroup member.
                for properties in [dict(MainPID=str(child.pid)), dict(ControlGroup='/workflowd')]:
                    cgroup = self.root / 'cgroups/workflowd'
                    cgroup.mkdir(parents=True, exist_ok=True)
                    (cgroup / 'cgroup.procs').write_text(str(child.pid))
                    self.unit_properties = {d.UNITS[0]: properties}
                    with patch.object(d, 'CGROUP_ROOT', cgroup.parent, create=True):
                        with self.assertRaises(PermissionError):
                            d.prune_releases(self.checkout, self.state, ['unused'],
                                             allow_unreadable={child.pid})
                    self.assertTrue(self.unused.exists())
                self.unit_properties = {}
                argv = ['verified-deploy.py', '--checkout', str(self.checkout),
                        '--prune', 'unused', '--allow-unreadable', str(child.pid)]
                with patch.object(d, 'DEPLOY_STATE', self.state), patch.object(d.sys, 'argv', argv):
                    d.main()
                self.assertFalse(self.unused.exists())
            finally:
                child.terminate()
                child.communicate()

    def test_acknowledgement_lists_all_pids_and_does_not_hide_readable_paths(self):
        for pid in [123, 456]:
            process = self.proc / str(pid)
            process.mkdir()
            (process / 'comm').write_text(f'fixture-{pid}')
            (process / 'cgroup').write_text('0::/other')
            (process / 'exe').symlink_to(self.root / 'safe')
        real_readlink = os.readlink

        def readlink(path):
            if Path(path).parent.parent == self.proc and Path(path).name == 'cwd':
                raise PermissionError('unreadable')
            return real_readlink(path)

        with patch.object(d.os, 'readlink', side_effect=readlink):
            output = io.StringIO()
            with patch.object(d.sys, 'stderr', output):
                with self.assertRaisesRegex(ValueError, '--allow-unreadable 456'):
                    d.prune_releases(self.checkout, self.state, ['unused'], allow_unreadable={123})
            for pid in [123, 456]:
                self.assertIn(f'PID={pid}', output.getvalue())
            exe = self.proc / '456/exe'
            exe.unlink()
            exe.symlink_to(self.unused)
            with self.assertRaisesRegex(ValueError, 'in use'):
                d.prune_releases(self.checkout, self.state, ['unused'], allow_unreadable={123, 456})
        self.assertTrue(self.unused.exists())

    def test_safe_systemd_working_directory_forms_allow_prune(self):
        self.unit_properties = {d.UNITS[0]: dict(WorkingDirectory='!' + str(self.root)),
                                d.UNITS[1]: dict(WorkingDirectory='~'),
                                d.UNITS[2]: dict(WorkingDirectory='!~')}
        with patch.object(Path, 'home', return_value=self.root):
            d.prune_releases(self.checkout, self.state, ['unused'])
        self.assertFalse(self.unused.exists())
