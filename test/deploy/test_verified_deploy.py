"""Offline policy tests; no GitHub access or service mutations."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy' / 'verified-deploy.py'
SHA = 'a' * 40
HEAD = 'b' * 40


def load_module():
    spec = importlib.util.spec_from_file_location('verified_deploy', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


d = load_module()


def check(**updates):
    row = dict(id=10, name='Required checks', head_sha=SHA,
               app={'id': 15368, 'slug': 'github-actions'},
               status='completed', conclusion='success', check_suite={'id': 20})
    return row | updates


def pr():
    return dict(number=42, merged_at='2026-01-01T00:00:00Z', merge_commit_sha=SHA,
                base={'ref': 'main', 'repo': {'full_name': 'BNasraoui/workflowd'}},
                head={'sha': HEAD}, user={'login': 'author'})


APP_ID = 98765


def approval(**updates):
    return check(name='Ben approval', head_sha=HEAD, app={'id': APP_ID}) | updates


class VerificationTests(unittest.TestCase):
    def test_successful_required_check(self):
        self.assertEqual(d.verify_checks([check()], SHA)['id'], 10)

    def test_missing_wrong_sha_app_or_non_success_is_refused(self):
        cases = [[], [check(head_sha=HEAD)], [check(app={'id': 1})]]
        cases += [[check(conclusion=value)] for value in
                  ['failure', 'neutral', 'skipped', 'cancelled', None]]
        cases += [[check(status='in_progress')]]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                d.verify_checks(rows, SHA)

    def test_newer_pending_or_failed_check_overrides_old_success(self):
        for status, conclusion in [('queued', None), ('completed', 'failure')]:
            with self.subTest(status=status), self.assertRaises(ValueError):
                d.verify_checks([check(), check(id=11, status=status, conclusion=conclusion)], SHA)

    def test_optional_check_does_not_block(self):
        self.assertEqual(d.verify_checks([check(), check(name='OpenCode Review', conclusion='failure')], SHA)['id'], 10)

    def test_only_main_push_ci_workflow_for_same_suite_is_accepted(self):
        run = dict(id=30, head_sha=SHA, head_branch='main', event='push',
                   path='.github/workflows/ci.yml', status='completed', conclusion='success',
                   check_suite_id=20, repository={'full_name': 'BNasraoui/workflowd'})
        self.assertEqual(d.verify_workflow([run], check(), SHA)['id'], 30)
        for key, value in [('head_sha', HEAD), ('head_branch', 'feature'),
                           ('event', 'pull_request'), ('path', 'other.yml'),
                           ('check_suite_id', 21), ('status', 'queued'),
                           ('conclusion', 'failure'), ('repository', {'full_name': 'other/repo'})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                d.verify_workflow([run | {key: value}], check(), SHA)
        with self.assertRaises(ValueError):
            d.verify_workflow([run, run | {'id': 31, 'status': 'queued'}], check(), SHA)

    def test_owner_authored_merge_uses_app_approval(self):
        self.assertEqual(d.verify_approval(pr(), [approval()], SHA, APP_ID)['id'], 10)

    def test_github_actions_cannot_be_configured_as_approval_app(self):
        with self.assertRaisesRegex(ValueError, 'GitHub Actions'):
            d.verify_approval(pr(), [approval(app={'id': 15368})], SHA, 15368)

    def test_unmerged_or_different_merge_is_refused(self):
        for change in [dict(merged_at=None), dict(merge_commit_sha=HEAD),
                       dict(base={'ref': 'other', 'repo': {'full_name': 'BNasraoui/workflowd'}})]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                d.verify_approval(pr() | change, [approval()], SHA, APP_ID)

    def test_missing_stale_wrong_app_or_unsuccessful_approval_is_refused(self):
        cases = [[], [approval(head_sha=SHA)], [approval(app={'id': 15368})],
                 [approval(name='Other')], [approval(status='queued')],
                 [approval(conclusion='failure')], [approval(conclusion='neutral')],
                 [approval(), approval(id=11, conclusion='cancelled')]]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                d.verify_approval(pr(), rows, SHA, APP_ID)

    def test_remote_verification_requests_approval_on_pr_head_and_ci_on_merge(self):
        run = dict(id=30, head_sha=SHA, head_branch='main', event='push',
                   path='.github/workflows/ci.yml', status='completed', conclusion='success',
                   check_suite_id=20, repository={'full_name': 'BNasraoui/workflowd'})
        responses = {
            f'commits/{SHA}/check-runs?filter=all&per_page=100': [check()],
            f'actions/workflows/ci.yml/runs?head_sha={SHA}&event=push&per_page=100': [run],
            f'commits/{SHA}/pulls?per_page=100': [pr()],
            f'commits/{HEAD}/check-runs?filter=all&per_page=100': [approval()],
        }
        with patch.object(d, 'api', side_effect=lambda endpoint, key=None, token=None: responses[endpoint]), \
             patch.object(d, 'command', return_value=json.dumps({'commit': {'tree': {'sha': 'c' * 40}}})) as call:
            evidence = d.verify_remote(SHA, APP_ID)
        self.assertEqual(evidence['tree'], 'c' * 40)
        self.assertIn(f'repos/{d.REPO}/commits/{SHA}', call.call_args.args)
        self.assertEqual(evidence['pr_head'], HEAD)
        self.assertEqual(evidence['sha'], SHA)
        self.assertEqual(evidence['approval_app_id'], APP_ID)


if __name__ == '__main__':
    unittest.main()
