"""Old release metadata must never supply a new deployment's files."""
import hashlib
import os
import shutil
import struct
import zlib
import unittest
from pathlib import Path
import subprocess
from unittest.mock import patch

import test_deploy_checkout as fixtures
from test_verified_deploy import d, APP_ID


class FreshReleaseTests(unittest.TestCase):
    setUp = fixtures.CheckoutTests.setUp
    commit = fixtures.CheckoutTests.commit
    release_fixture = fixtures.CheckoutTests.release_fixture
    # Reuse the repository fixture, without duplicating its test cases.
    def attack_deploy(self, attack):
        source = self.root / 'github'
        shutil.copytree(self.repo, source)
        d.git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture',
              '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'next release')
        self.sha = d.git(source, 'rev-parse', 'HEAD')
        tree = d.git(source, 'rev-parse', 'HEAD^{tree}')
        attack()
        old = self.release_fixture()
        old_git = old / '.git'
        retained = {path.relative_to(old): path.read_bytes()
                    for path in old.rglob('*') if path.is_file()}
        calls = []
        self.old_release = old
        real_command = d.command
        real_run = subprocess.run

        def command(*args, **kwargs):
            if args[0] == 'systemctl':
                if args[2] == 'stop':
                    self.assertEqual(self.repo.resolve(), old)
                elif args[2] == 'restart':
                    self.assertNotEqual(self.repo.resolve(), old)
                calls.append(args[2])
                return ''
            if 'fetch' in args:
                # Substitute only the transport endpoint, retaining a real fetch
                # into whichever directory production selected.
                argv = list(args)
                start = argv.index('fetch')
                for i in range(start + 1, len(argv)):
                    if argv[i] in ('origin', d.REMOTE):
                        argv[i] = str(source)
                argv[1:1] = ['-c', 'protocol.file.allow=always']
                return real_command(*argv, **kwargs)
            if args[0] == 'git' and '-C' in args:
                self.assertNotEqual(Path(args[args.index('-C') + 1]).resolve(), old)
            return real_command(*args, **kwargs)

        def run(args, **kwargs):
            if args[0] == str(self.bun):
                self.assertEqual(self.repo.resolve(), old)
                checkout = Path(kwargs['cwd'])
                self.assertEqual((checkout / 'tracked').read_text(), 'reviewed file\n')
                self.assertNotEqual((checkout / '.git').resolve(), old_git.resolve())
                self.assertEqual((checkout / '.git').stat().st_mode & 0o777, 0o700)
                return subprocess.CompletedProcess(args, 0)
            return real_run(args, **kwargs)

        with patch.object(d, 'command', side_effect=command), \
             patch.object(d.subprocess, 'run', side_effect=run), \
             patch.object(d, 'verify_remote', return_value={'tree': tree}):
            d.deploy(self.repo, self.sha, self.skills, self.state, APP_ID, self.bun, bootstrap=True)
        self.assertEqual((self.repo / 'tracked').read_text(), 'reviewed file\n')
        self.assertEqual(self.state.read_text().strip(), self.sha)
        self.assertTrue(self.repo.is_symlink())
        self.assertEqual((self.repo.parent / 'previous').resolve(), old)
        self.assertTrue(old_git.is_dir())
        self.assertEqual({path.relative_to(old): path.read_bytes()
                          for path in old.rglob('*') if path.is_file()}, retained)

    def test_old_skip_worktree_cannot_supply_deployed_file(self):
        def attack():
            d.git(self.repo, 'update-index', '--skip-worktree', 'tracked')
            (self.repo / 'tracked').write_text('EVIL contents\n')
        self.attack_deploy(attack)

    def test_old_forged_index_stat_cannot_supply_deployed_file(self):
        def attack():
            path = self.repo / 'tracked'
            path.write_text('EVIL contents\n')
            info = path.stat()
            index = self.repo / '.git/index'
            data = bytearray(index.read_bytes())
            # Index v2: ten 32-bit stat fields, blob ID, flags, then path.
            offset = data.index(b'tracked\0') - 62
            fields = (int(info.st_ctime), info.st_ctime_ns % 10**9,
                      int(info.st_mtime), info.st_mtime_ns % 10**9,
                      info.st_dev & 0xffffffff, info.st_ino & 0xffffffff,
                      0o100644, info.st_uid, info.st_gid, info.st_size)
            struct.pack_into('>10I', data, offset, *fields)
            data[-20:] = hashlib.sha1(data[:-20]).digest()
            index.write_bytes(data)
            # Avoid Git's racily-clean timestamp protection.
            os.utime(index, (info.st_mtime + 10, info.st_mtime + 10))
        self.attack_deploy(attack)

    def test_old_poisoned_loose_object_cannot_supply_deployed_file(self):
        def attack():
            blob = d.git(self.repo, 'rev-parse', 'HEAD:tracked')
            path = self.repo / '.git/objects' / blob[:2] / blob[2:]
            payload = b'EVIL contents\n'
            path.chmod(0o600)
            path.write_bytes(zlib.compress(b'blob ' + str(len(payload)).encode() + b'\0' + payload))
            (self.repo / 'tracked').unlink()
        self.attack_deploy(attack)

    def test_old_config_and_info_files_are_never_read(self):
        def attack():
            (self.repo / '.git/config').write_text('not even valid Git config!')
            (self.repo / '.git/info/grafts').write_text('malformed')
            (self.repo / '.git/info/sparse-checkout').write_text('nothing')
        self.attack_deploy(attack)

    def test_fresh_fsck_failure_preserves_active_release_and_state(self):
        real_git = d.git

        def git(checkout, *args):
            result = real_git(checkout, *args)
            if args[:1] == ('checkout',):
                blob = real_git(checkout, 'rev-parse', 'HEAD:tracked')
                path = checkout / '.git/objects' / blob[:2] / blob[2:]
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(zlib.compress(b'blob 4\0EVIL'))
            return result

        with patch.object(d, 'git', side_effect=git):
            with self.assertRaises(subprocess.CalledProcessError):
                self.attack_deploy(lambda: None)
        self.assertEqual(self.repo.resolve(), self.old_release)
        self.assertFalse(self.state.exists())
        self.assertEqual(list((self.repo.parent / 'releases').iterdir()), [self.old_release])

    def test_restart_failure_retains_both_releases_without_advancing_state(self):
        real_replace = os.replace
        previous_sha = self.sha
        self.state.write_text(previous_sha + '\n')
        self.state.chmod(0o600)

        def activate(source, destination):
            real_replace(source, destination)
            if Path(destination) == self.repo:
                # Simulate failure immediately after the atomic switch.
                raise OSError('restart unavailable')

        with patch.object(d.os, 'replace', side_effect=activate):
            with self.assertRaisesRegex(OSError, 'restart unavailable'):
                self.attack_deploy(lambda: None)
        self.assertNotEqual(self.repo.resolve(), self.old_release)
        self.assertEqual((self.repo.parent / 'previous').resolve(), self.old_release)
        self.assertEqual(len(list((self.repo.parent / 'releases').iterdir())), 2)
        self.assertEqual(self.state.read_text().strip(), previous_sha)

    def test_activation_replaces_current_in_one_rename(self):
        real_replace = os.replace
        switches = []

        def replace(source, destination):
            if Path(destination) == self.repo:
                switches.append((self.repo.resolve(), Path(source).resolve()))
                self.assertEqual(self.repo.resolve(), self.old_release)
            real_replace(source, destination)

        with patch.object(d.os, 'replace', side_effect=replace):
            self.attack_deploy(lambda: None)
        self.assertEqual(len(switches), 1)
        self.assertEqual(switches[0][1], self.repo.resolve())
