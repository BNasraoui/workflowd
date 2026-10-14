"""Real disposable Git repositories; only GitHub, Bun and systemd are mocked."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_verified_deploy import d


class CheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'deploy'
        self.repo.mkdir()
        d.git(self.repo, 'init', '-q', '-b', 'main')
        d.git(self.repo, 'config', 'user.name', 'Fixture')
        d.git(self.repo, 'config', 'user.email', 'fixture')
        d.git(self.repo, 'remote', 'add', 'origin', d.REMOTE)
        skill = self.repo / 'skills/rpi-example'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('reviewed skill\n')
        (self.repo / 'tracked').write_text('reviewed file\n')
        self.commit()
        self.sha = d.git(self.repo, 'rev-parse', 'HEAD')
        d.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.sha)
        self.skills = self.root / 'skills'

    def commit(self):
        d.git(self.repo, 'add', '.')
        d.git(self.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

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
        self.skills.mkdir()
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
        d.git(self.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'submodule fixture')
        with self.assertRaises(ValueError):
            d.copy_skills(self.repo, d.git(self.repo, 'rev-parse', 'HEAD'), self.skills)

    def test_api_pages_are_flattened_and_errors_propagate(self):
        with patch.object(d, 'command', return_value=json.dumps([
            {'check_runs': [{'id': 1}]}, {'check_runs': [{'id': 2}]}])) as call:
            self.assertEqual(d.api('endpoint', 'check_runs'), [{'id': 1}, {'id': 2}])
            self.assertIn('--paginate', call.call_args.args)
            self.assertIn('--slurp', call.call_args.args)
        with patch.object(d, 'command', side_effect=subprocess.CalledProcessError(1, 'gh')):
            with self.assertRaises(subprocess.CalledProcessError):
                d.verify_remote(self.sha)

    def run_deploy(self, verification_error=None, install_error=False):
        events = []
        real_command = d.command
        real_run = subprocess.run

        def command(*args, **kwargs):
            if args[0] == 'systemctl':
                events.append(args[2])
                return ''
            if 'fetch' in args:
                return ''  # origin/main was set by the local fixture
            return real_command(*args, **kwargs)

        def run(args, **kwargs):
            if args[0] == 'bun':
                events.append('install')
                self.assertEqual(args, ['bun', 'install', '--frozen-lockfile'])
                self.assertEqual(d.git(self.repo, 'rev-parse', 'HEAD'), self.sha)
                self.assertEqual((self.repo / 'tracked').read_text(), 'reviewed file\n')
                self.assertFalse((self.repo / 'untracked').exists())
                self.assertTrue((self.repo / 'node_modules/keep').exists())
                if install_error:
                    raise subprocess.CalledProcessError(1, 'bun')
                return subprocess.CompletedProcess(args, 0)
            return real_run(args, **kwargs)

        with patch.object(d, 'command', side_effect=command), \
             patch.object(d.subprocess, 'run', side_effect=run), \
             patch.object(d, 'verify_remote', side_effect=verification_error,
                          return_value={'pr': 42, 'check_id': 10, 'run_id': 30}):
            if verification_error or install_error:
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    d.deploy(self.repo, self.sha, self.skills)
            else:
                d.deploy(self.repo, self.sha, self.skills)
        return events

    def dirty(self):
        (self.repo / 'tracked').write_text('dirty\n')
        (self.repo / 'untracked').write_text('remove\n')
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules/keep').write_text('retained\n')

    def test_refusal_does_not_install_restart_or_reset(self):
        self.dirty()
        self.assertEqual(self.run_deploy(ValueError('CI unavailable')), [])
        self.assertEqual((self.repo / 'tracked').read_text(), 'dirty\n')
        self.assertFalse((self.repo / '.git/verified-deploy.jsonl').exists())

    def test_deployment_cleans_installs_copies_restarts_and_records(self):
        self.dirty()
        self.assertEqual(self.run_deploy(), ['stop', 'install', 'restart', 'is-active'])
        rows = [json.loads(line) for line in
                (self.repo / '.git/verified-deploy.jsonl').read_text().splitlines()]
        self.assertEqual([row['status'] for row in rows], ['verified', 'deployed'])
        self.assertEqual(rows[-1]['sha'], self.sha)
        self.assertTrue((self.skills / 'rpi-example/SKILL.md').is_file())

    def test_install_failure_is_logged_without_restart_or_success(self):
        self.dirty()
        self.assertEqual(self.run_deploy(install_error=True), ['stop', 'install'])
        rows = [json.loads(line) for line in
                (self.repo / '.git/verified-deploy.jsonl').read_text().splitlines()]
        self.assertEqual([row['status'] for row in rows], ['verified', 'failed'])
