"""Real disposable Git repositories; only GitHub, Bun and systemd are mocked."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

from test_verified_deploy import d, APP_ID


class CheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'deployment/current'
        self.repo.mkdir(parents=True)
        self.repo.parent.chmod(0o755)
        d.git(self.repo, 'init', '-q', '-b', 'main')
        d.git(self.repo, 'remote', 'add', 'origin', d.REMOTE)
        skill = self.repo / 'skills/rpi-example'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('reviewed skill\n')
        (self.repo / 'tracked').write_text('reviewed file\n')
        self.commit()
        self.sha = d.git(self.repo, 'rev-parse', 'HEAD')
        d.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.sha)
        self.skills = self.root / 'skills'
        self.skills.mkdir()
        (self.skills / '.workflowd-verified-skills').touch()
        self.state = self.root / 'last-deployed'
        self.bun = Path('/operator/bin/bun')

    def commit(self):
        d.git(self.repo, 'add', '.')
        d.git(self.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture',
              '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

    def test_standalone_clone_and_main_membership(self):
        d.standalone(self.repo)
        self.assertEqual(d.git(self.repo, 'config', '--local', 'core.hooksPath'), '/dev/null')
        d.verify_main(self.repo, self.sha)
        (self.repo / 'tracked').write_text('branch only\n')
        self.commit()
        with self.assertRaises(subprocess.CalledProcessError):
            d.verify_main(self.repo, d.git(self.repo, 'rev-parse', 'HEAD'))
        with self.assertRaises(ValueError):
            d.verify_main(self.repo, 'main')

    def test_linked_worktree_and_shared_object_store_are_refused(self):
        linked = self.root / 'linked'
        d.git(self.repo, 'worktree', 'add', '--detach', str(linked), self.sha)
        with self.assertRaises(ValueError):
            d.standalone(linked)
        with self.assertRaises(ValueError):
            d.standalone(self.repo)
        d.git(self.repo, 'worktree', 'remove', str(linked))
        # Git leaves an empty worktrees directory; remove it for the next case.
        directory = self.repo / '.git/worktrees'
        if directory.exists():
            directory.rmdir()
        (self.repo / '.git/objects/info/alternates').write_text('/missing\n')
        with self.assertRaises(ValueError):
            d.standalone(self.repo)

    def test_skills_are_commit_copies_and_old_link_target_is_untouched(self):
        (self.repo / 'skills/rpi-example/SKILL.md').write_text('uncommitted\n')
        external = self.root / 'external'
        external.mkdir()
        (external / 'keep').write_text('keep')
        (self.skills / 'rpi-example').symlink_to(external, target_is_directory=True)
        (self.skills / 'rpi-obsolete').mkdir()
        d.copy_skills(self.repo, self.sha, self.skills)
        self.assertFalse((self.skills / 'rpi-example').is_symlink())
        self.assertEqual((self.skills / 'rpi-example/SKILL.md').read_text(), 'reviewed skill\n')
        self.assertTrue((external / 'keep').exists())
        self.assertFalse((self.skills / 'rpi-obsolete').exists())

    def test_skill_symlink_is_refused(self):
        (self.repo / 'skills/rpi-example/link').symlink_to('SKILL.md')
        self.commit()
        with self.assertRaises(ValueError):
            d.copy_skills(self.repo, d.git(self.repo, 'rev-parse', 'HEAD'), self.skills)

    def test_skill_submodule_is_refused(self):
        d.git(self.repo, 'update-index', '--add', '--cacheinfo',
              f'160000,{self.sha},skills/rpi-nested')
        d.git(self.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture',
              '-c', 'commit.gpgsign=false', 'commit', '-qm', 'submodule fixture')
        with self.assertRaises(ValueError):
            d.copy_skills(self.repo, d.git(self.repo, 'rev-parse', 'HEAD'), self.skills)

    def test_api_pages_are_flattened_and_errors_propagate(self):
        with patch.object(d, 'command', return_value=' {"check_runs":[{"id":1}]}\n{"check_runs":[{"id":2}]} ') as call:
            self.assertEqual(d.api('endpoint', 'check_runs'), [{'id': 1}, {'id': 2}])
            self.assertIn('--paginate', call.call_args.args)
            self.assertNotIn('--slurp', call.call_args.args)
        with patch.object(d, 'command', side_effect=subprocess.CalledProcessError(1, 'gh')):
            with self.assertRaises(subprocess.CalledProcessError):
                d.verify_remote(self.sha, APP_ID)

    def release_fixture(self):
        if not self.repo.is_symlink():
            releases = self.repo.parent / 'releases'
            releases.mkdir(mode=0o700)
            old = releases / 'old'
            self.repo.rename(old)
            self.repo.symlink_to(old)
        return self.repo.resolve()

    def run_deploy(self, verification_error=None, install_error=False, tree=None, initial=False, restart_error=False):
        source = Path(tempfile.mkdtemp(dir=self.root)) / 'github'
        shutil.copytree(self.repo, source)
        d.git(source, 'update-ref', 'refs/heads/main', self.sha)
        self.release_fixture()
        if initial:
            self.repo.unlink()
        events = self.events = []
        real_command = d.command
        real_run = subprocess.run

        def command(*args, **kwargs):
            if args[0] == 'systemctl':
                events.append(args[2])
                if args[2] == 'restart' and restart_error:
                    raise subprocess.CalledProcessError(1, args)
                return ''
            if 'fetch' in args:
                argv = list(args)
                argv = [str(source) if arg in ('origin', d.REMOTE) else arg for arg in argv]
                argv[1:1] = ['-c', 'protocol.file.allow=always']
                return real_command(*argv, **kwargs)
            return real_command(*args, **kwargs)

        def run(args, **kwargs):
            if args[0] == str(self.bun):
                events.append('install')
                self.assertEqual(args, [str(self.bun), 'install', '--frozen-lockfile', '--no-cache', '--backend=copyfile'])
                self.assertEqual(d.git(Path(kwargs['cwd']), 'rev-parse', 'HEAD'), self.sha)
                self.assertEqual((Path(kwargs['cwd']) / 'tracked').read_text(), 'reviewed file\n')
                self.assertFalse((Path(kwargs['cwd']) / 'untracked').exists())
                self.assertFalse((Path(kwargs['cwd']) / 'node_modules').exists())
                self.assertFalse((Path(kwargs['cwd']) / 'pkg/node_modules/evil.js').exists())
                if install_error:
                    raise subprocess.CalledProcessError(1, 'bun')
                return subprocess.CompletedProcess(args, 0)
            return real_run(args, **kwargs)

        with patch.object(d, 'command', side_effect=command), \
             patch.object(d.subprocess, 'run', side_effect=run), \
             patch.object(d, 'verify_remote', side_effect=verification_error,
                          return_value={'pr': 42, 'check_id': 10, 'run_id': 30,
                                        'tree': tree or d.git(source, 'rev-parse', f'{self.sha}^{{tree}}')}):
            if verification_error or install_error:
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    d.deploy(self.repo, self.sha, self.skills, self.state, APP_ID, self.bun, bootstrap=True)
            else:
                d.deploy(self.repo, self.sha, self.skills, self.state, APP_ID, self.bun, bootstrap=True)
        return events

    def dirty(self):
        (self.repo / 'tracked').write_text('dirty\n')
        (self.repo / 'untracked').write_text('remove\n')
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules/keep').write_text('retained\n')
        (self.repo / 'pkg/node_modules').mkdir(parents=True)
        (self.repo / 'pkg/node_modules/evil.js').touch()

    def test_refusal_does_not_install_restart_or_reset(self):
        self.dirty()
        self.assertEqual(self.run_deploy(ValueError('CI unavailable')), [])
        self.assertEqual((self.repo / 'tracked').read_text(), 'dirty\n')
        self.assertFalse((self.state.parent / 'verified-deploy.jsonl').exists())

    def test_deployment_cleans_installs_copies_restarts_and_records(self):
        self.dirty()
        self.assertEqual(self.run_deploy(), ['install', 'stop', 'restart', 'is-active'])
        rows = [json.loads(line) for line in
                (self.state.parent / 'verified-deploy.jsonl').read_text().splitlines()]
        self.assertEqual([row['status'] for row in rows], ['verified', 'deployed'])
        self.assertEqual(rows[-1]['sha'], self.sha)
        self.assertEqual(self.state.read_text().strip(), self.sha)
        self.assertTrue((self.skills / 'rpi-example/SKILL.md').is_file())

    def test_install_failure_is_logged_without_restart_or_success(self):
        self.dirty()
        self.assertEqual(self.run_deploy(install_error=True), ['install'])
        rows = [json.loads(line) for line in
                (self.state.parent / 'verified-deploy.jsonl').read_text().splitlines()]
        self.assertEqual([row['status'] for row in rows], ['verified', 'failed'])

    def test_install_failure_preserves_last_deployed_state(self):
        previous = self.sha
        self.state.write_text(previous + '\n')
        self.state.chmod(0o600)
        d.git(self.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture',
              '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'next merge')
        self.sha = d.git(self.repo, 'rev-parse', 'HEAD')
        d.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.sha)
        self.dirty()
        self.run_deploy(install_error=True)
        self.assertEqual(self.state.read_text().strip(), previous)

    def test_marker_is_required_before_deleting_skills(self):
        (self.skills / '.workflowd-verified-skills').unlink()
        old = self.skills / 'rpi-personal'
        old.mkdir()
        with self.assertRaisesRegex(ValueError, 'marker'):
            d.copy_skills(self.repo, self.sha, self.skills)
        self.assertTrue(old.exists())

    def test_skill_names_with_newlines_tabs_and_quotes(self):
        relative = 'skills/rpi-example/odd\n\t" name '
        (self.repo / relative).write_text('exact bytes')
        self.commit()
        d.copy_skills(self.repo, d.git(self.repo, 'rev-parse', 'HEAD'), self.skills)
        self.assertEqual((self.skills / relative.removeprefix('skills/')).read_text(), 'exact bytes')

    def test_command_and_traffic_redirecting_config_is_refused(self):
        for key in ['include.path', 'includeIf.gitdir:/.path', 'filter.evil.clean',
                    'core.fsmonitor', 'credential.helper', 'http.proxy', 'url.evil.insteadOf']:
            with self.subTest(key=key):
                d.git(self.repo, 'config', '--local', key, '/nonexistent')
                with self.assertRaisesRegex(ValueError, 'config'):
                    d.standalone(self.repo)
                d.git(self.repo, 'config', '--local', '--unset', key)
        (self.repo / '.git/info/attributes').touch()
        with self.assertRaisesRegex(ValueError, 'attributes'):
            d.standalone(self.repo)

    def test_replacement_refs_grafts_and_sparse_checkout_are_refused(self):
        for relative in ['refs/replace', 'info/grafts', 'info/sparse-checkout']:
            with self.subTest(relative=relative):
                path = self.repo / '.git' / relative
                if relative == 'refs/replace':
                    path.mkdir()
                else:
                    path.touch()
                try:
                    with self.assertRaisesRegex(ValueError, 'forbidden'):
                        d.standalone(self.repo)
                finally:
                    path.rmdir() if path.is_dir() else path.unlink()
                # Dangling symlinks must also be refused.
                path.symlink_to(self.root / 'absent')
                try:
                    with self.assertRaisesRegex(ValueError, 'forbidden'):
                        d.standalone(self.repo)
                finally:
                    path.unlink()

    def test_local_configuration_is_an_allow_list(self):
        for key, value in [('core.sparseCheckout', 'true'), ('core.symlinks', 'false'),
                           ('remote.origin.proxy', 'http://localhost:1'),
                           ('user.name', 'Unexpected'), ('new.setting', 'unknown')]:
            with self.subTest(key=key):
                d.git(self.repo, 'config', '--local', key, value)
                try:
                    with self.assertRaisesRegex(ValueError, 'config'):
                        d.standalone(self.repo)
                finally:
                    d.git(self.repo, 'config', '--local', '--unset', key)
        d.standalone(self.repo)
        d.standalone(self.repo)  # The persisted hooksPath remains allowed.

    def test_tracked_node_modules_is_also_removed_before_install(self):
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules/keep').write_text('stale dependency')
        self.commit()
        self.sha = d.git(self.repo, 'rev-parse', 'HEAD')
        d.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.sha)
        self.assertEqual(self.run_deploy(), ['install', 'stop', 'restart', 'is-active'])

    def test_environment_disables_packed_replace_refs_and_grafted_history(self):
        original = self.sha
        commits = []
        for content in ['middle', 'EVIL']:
            (self.repo / 'tracked').write_text(content)
            self.commit()
            commits.append(d.git(self.repo, 'rev-parse', 'HEAD'))
        d.git(self.repo, 'replace', original, commits[-1])
        d.git(self.repo, 'pack-refs', '--all', '--prune')
        self.assertEqual(d.git(self.repo, 'show', f'{original}:tracked'), 'EVIL')
        (self.repo / '.git/info/grafts').write_text(f'{commits[-1]} {original}\n')
        token = self.root / 'token'
        token.write_text('fixture')
        token.chmod(0o600)
        with patch.dict(os.environ):
            d.configure_environment(token, self.root)
            self.assertEqual(d.git(self.repo, 'show', f'{original}:tracked'), 'reviewed file')
            self.assertEqual(d.git(self.repo, 'rev-list', '--first-parent', '--reverse',
                                   f'{original}..{commits[-1]}').splitlines(), commits)

    def test_checkout_tree_must_match_github_before_install_or_restart(self):
        self.dirty()
        with self.assertRaisesRegex(ValueError, 'tree'):
            self.run_deploy(tree='f' * 40)
        self.assertEqual(self.events, [])
        self.assertFalse(self.state.exists())
        rows = [json.loads(line) for line in
                (self.state.parent / 'verified-deploy.jsonl').read_text().splitlines()]
        self.assertEqual([row['status'] for row in rows], ['verified', 'failed'])

    def test_lock_and_log_symlinks_are_refused_before_stop(self):
        self.dirty()
        victim = self.root / 'operator-file'
        victim.write_text('untouched')
        for name in ['verified-deploy.lock', 'verified-deploy.jsonl']:
            for target in [victim, self.root / 'absent']:
                with self.subTest(name=name, target=target):
                    link = self.state.parent / name
                    link.unlink(missing_ok=True)
                    link.symlink_to(target)
                    try:
                        with self.assertRaises(OSError):
                            self.run_deploy()
                        self.assertEqual(self.events, [])
                        self.assertEqual(victim.read_text(), 'untouched')
                        self.assertFalse((self.root / 'absent').exists())
                        self.assertEqual((self.repo / 'tracked').read_text(), 'dirty\n')
                    finally:
                        link.unlink()

    def test_git_wrapper_disables_fsmonitor_commands(self):
        witness = self.root / 'executed'
        script = self.root / 'fsmonitor'
        script.write_text('#!/bin/sh\ntouch ' + str(witness) + '\n')
        script.chmod(0o755)
        d.git(self.repo, 'config', 'core.fsmonitor', str(script))
        d.git(self.repo, 'status', '--porcelain')
        self.assertFalse(witness.exists())

    def test_first_parent_range_and_explicit_bootstrap(self):
        with self.assertRaisesRegex(ValueError, 'bootstrap'):
            d.deployment_commits(self.repo, self.sha, self.state, False)
        self.assertEqual(d.deployment_commits(self.repo, self.sha, self.state, True), [self.sha])
        self.state.write_text(self.sha + '\n')
        self.state.chmod(0o600)
        commits = []
        for content in ['unapproved earlier merge', 'approved target']:
            (self.repo / 'tracked').write_text(content)
            self.commit()
            commits.append(d.git(self.repo, 'rev-parse', 'HEAD'))
        self.assertEqual(d.deployment_commits(self.repo, commits[-1], self.state, False), commits)
        self.state.write_text(commits[-1] + '\n')
        with self.assertRaisesRegex(ValueError, 'ancestor'):
            d.deployment_commits(self.repo, self.sha, self.state, False)
        self.assertEqual(d.deployment_commits(self.repo, self.sha, self.state, True), [self.sha])

    def test_earlier_unapproved_commit_blocks_before_stop(self):
        self.state.write_text(self.sha + '\n')
        self.state.chmod(0o600)
        (self.repo / 'tracked').write_text('unapproved')
        self.commit()
        bad = d.git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'tracked').write_text('reviewed file\n')
        self.commit()
        self.sha = d.git(self.repo, 'rev-parse', 'HEAD')
        d.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.sha)
        visited = []

        def verify(sha, app_id, token=None):
            visited.append(sha)
            if sha == bad:
                raise ValueError('unapproved earlier merge')
            return {'pr': 42}

        self.assertEqual(self.run_deploy(verify), [])
        self.assertEqual(visited, [bad])

    def test_state_parent_must_be_operator_owned_and_private_before_stop(self):
        self.root.chmod(0o777)
        self.dirty()
        self.assertEqual(self.run_deploy(ValueError('should not get to GitHub')), [])
        with self.assertRaisesRegex(ValueError, 'state directory'):
            d.deployment_commits(self.repo, self.sha, self.state, True)

    def test_initial_deploy_creates_current_without_previous(self):
        self.run_deploy(initial=True)
        self.assertTrue(self.repo.is_symlink())
        self.assertFalse((self.repo.parent / 'previous').exists())
        self.assertEqual(self.state.read_text().strip(), self.sha)

    def test_same_sha_redeploy_also_gets_new_git_and_keeps_previous(self):
        self.run_deploy()
        first = self.repo.resolve()
        first_index = (first / '.git/index').read_bytes()
        self.run_deploy()
        self.assertNotEqual(self.repo.resolve(), first)
        self.assertEqual((self.repo.parent / 'previous').resolve(), first)
        self.assertEqual((first / '.git/index').read_bytes(), first_index)

    def test_previous_directory_is_refused_before_stop(self):
        previous = self.repo.parent / 'previous'
        previous.mkdir()
        (previous / 'keep').write_text('untouched')
        with self.assertRaisesRegex(ValueError, 'Previous'):
            self.run_deploy()
        self.assertEqual(self.events, [])
        self.assertEqual((previous / 'keep').read_text(), 'untouched')
        self.assertFalse(self.state.exists())

    def test_read_only_activation_parent_is_refused_before_stop(self):
        old = self.release_fixture()
        self.repo.parent.chmod(0o555)
        try:
            with self.assertRaises(PermissionError):
                self.run_deploy()
            self.assertEqual(self.events, ['install'])
            self.assertEqual(self.repo.resolve(), old)
            self.assertFalse(self.state.exists())
        finally:
            self.repo.parent.chmod(0o755)

    def test_both_activation_links_are_prepared_before_stop(self):
        real_symlink = Path.symlink_to
        prepared = []

        def symlink(link, target, **kwargs):
            if link.parent.name.startswith('.activate-'):
                self.assertNotIn('stop', self.events)
                prepared.append(link)
            return real_symlink(link, target, **kwargs)

        with patch.object(Path, 'symlink_to', symlink):
            self.run_deploy()
        self.assertEqual(len(prepared), 2)
        self.assertEqual(prepared[0].parent, prepared[1].parent)
        self.assertFalse(prepared[0].parent.exists())

    def test_bad_skill_tree_is_refused_before_stop(self):
        for invalid in ['symlink', 'missing SKILL.md']:
            with self.subTest(invalid=invalid):
                skill = self.repo / 'skills/rpi-example/SKILL.md'
                skill.unlink()
                if invalid == 'symlink':
                    skill.symlink_to('../../tracked')
                else:
                    (skill.parent / 'other').touch()
                self.commit()
                self.sha = d.git(self.repo, 'rev-parse', 'HEAD')
                with self.assertRaises(ValueError):
                    self.run_deploy()
                self.assertEqual(self.events, ['install'])
                self.assertFalse(self.state.exists())
                skill.unlink(missing_ok=True)
                skill.write_text('reviewed skill')

    def test_skill_copy_io_failure_does_not_stop_services(self):
        with patch.object(d, 'copy_skills', side_effect=OSError('copy failed')):
            with self.assertRaisesRegex(OSError, 'copy failed'):
                self.run_deploy()
        self.assertEqual(self.events, ['install'])
        self.assertFalse(self.state.exists())

    def test_activation_directory_is_synced_before_restart_even_when_restart_fails(self):
        real_fsync = os.fsync
        synced = []
        old = self.release_fixture()

        def fsync(descriptor):
            if os.fstat(descriptor).st_ino == self.repo.parent.stat().st_ino:
                self.assertNotEqual(self.repo.resolve(), old)
                self.assertEqual((self.repo.parent / 'previous').resolve(), old)
                synced.append(self.events.copy())
            return real_fsync(descriptor)

        with patch.object(d.os, 'fsync', side_effect=fsync):
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_deploy(restart_error=True)
        self.assertEqual(synced, [['install', 'stop']])
