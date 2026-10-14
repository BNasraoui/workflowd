#!/usr/bin/env python3
"""Operator-only deployment. See verified-deploy.md for the trust boundary."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

REPO = 'BNasraoui/workflowd'
REMOTE = f'https://github.com/{REPO}.git'
UNITS = ['workflowd.service', 'workflowd-runner.service', 'workflowd-mcp.service']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_checks(rows, sha):
    candidates = [row for row in rows if row.get('name') == 'Required checks'
                  and row.get('app', {}).get('id') == 15368
                  and row.get('app', {}).get('slug') == 'github-actions']
    require(candidates, 'Required checks from GitHub Actions is missing')
    check = max(candidates, key=lambda row: row['id'])
    require(check.get('head_sha') == sha and check.get('status') == 'completed'
            and check.get('conclusion') == 'success',
            'Latest Required checks must succeed for the exact deployment SHA')
    return check


def verify_workflow(rows, check, sha):
    require(rows, 'CI workflow run is missing')
    run = max(rows, key=lambda row: row['id'])
    require(run.get('head_sha') == sha and run.get('head_branch') == 'main'
            and run.get('event') == 'push'
            and run.get('path') == '.github/workflows/ci.yml'
            and run.get('repository', {}).get('full_name') == REPO
            and run.get('check_suite_id') == check['check_suite']['id']
            and run.get('status') == 'completed' and run.get('conclusion') == 'success',
            'Latest main push CI must succeed and own the required check')
    return run


def verify_review(pr, reviews, sha):
    require(pr.get('merged_at') and pr.get('merge_commit_sha') == sha
            and pr.get('base', {}).get('ref') == 'main'
            and pr.get('base', {}).get('repo', {}).get('full_name') == REPO,
            'Target must be the merge result of a PR into this repository main')
    latest = {}
    for review in sorted(reviews, key=lambda row: row['id']):
        if review.get('state') in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
            latest[review['user']['login']] = review
    require(not any(row['state'] == 'CHANGES_REQUESTED' for row in latest.values()),
            'PR has an outstanding change request')
    require(any(row['state'] == 'APPROVED' and row.get('commit_id') == pr['head']['sha']
                and row['user'].get('type') == 'User'
                and row['user']['login'] != pr['user']['login']
                and row.get('author_association') in ('OWNER', 'MEMBER', 'COLLABORATOR')
                for row in latest.values()),
            'PR needs an undismissed maintainer approval of its final head')


def command(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE).stdout.strip()


def git(checkout, *args):
    return command('git', '-c', 'core.hooksPath=/dev/null', '-C', str(checkout), *args)


def api(endpoint, key=None):
    pages = json.loads(command('gh', 'api', '--hostname', 'github.com',
                               '--paginate', '--slurp', f'repos/{REPO}/{endpoint}'))
    return [item for page in pages for item in (page[key] if key else page)]


def verify_remote(sha):
    checks = api(f'commits/{sha}/check-runs?filter=all&per_page=100', 'check_runs')
    check = verify_checks(checks, sha)
    runs = api(f'actions/workflows/ci.yml/runs?head_sha={sha}&event=push&per_page=100',
               'workflow_runs')
    run = verify_workflow(runs, check, sha)
    for pr in api(f'commits/{sha}/pulls?per_page=100'):
        if pr.get('merge_commit_sha') != sha or not pr.get('merged_at'):
            continue
        reviews = api(f'pulls/{pr["number"]}/reviews?per_page=100')
        verify_review(pr, reviews, sha)
        return {'pr': pr['number'], 'check_id': check['id'], 'run_id': run['id']}
    raise ValueError('No merged PR found for the exact deployment SHA')


def standalone(checkout):
    metadata = checkout / '.git'
    require(metadata.is_dir() and not metadata.is_symlink(),
            'Deployment requires a standalone clone with its own .git directory')
    require(Path(git(checkout, 'rev-parse', '--show-toplevel')).resolve() == checkout,
            'Deployment path must be the clone root')
    common = Path(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    require(common.resolve() == metadata and not (metadata / 'commondir').exists()
            and not (metadata / 'objects/info/alternates').exists()
            and not (metadata / 'worktrees').exists(),
            'Shared Git metadata, worktrees or object stores are not supported')
    require(git(checkout, 'remote', 'get-url', 'origin') == REMOTE,
            'origin must be the canonical HTTPS repository')
    git(checkout, 'config', '--local', 'core.hooksPath', '/dev/null')


def verify_main(checkout, sha):
    require(re.fullmatch(r'[0-9a-f]{40}', sha), 'Use a full lowercase commit SHA')
    require(git(checkout, 'rev-parse', f'{sha}^{{commit}}') == sha, 'Target is not a commit')
    git(checkout, 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main')


def copy_skills(checkout, sha, target):
    """Read blobs from the verified commit, never from checkout skill symlinks."""
    require(not target.is_symlink(), 'Skill destination must not be a symlink')
    target.mkdir(parents=True, exist_ok=True)
    entries = git(checkout, 'ls-tree', '-r', sha, '--', 'skills').splitlines()
    skills = {}
    for entry in entries:
        metadata, name = entry.split('\t', 1)
        parts = Path(name).parts
        if len(parts) < 2 or not parts[1].startswith('rpi-'):
            continue
        mode, kind, blob = metadata.split()
        require(mode in ('100644', '100755') and kind == 'blob',
                'Skill sources must contain only regular tracked files')
        skills.setdefault(parts[1], []).append((Path(*parts[2:]), mode, blob))
    require(skills, 'No tracked RPI skills found')
    for name, files in skills.items():
        require(any(path == Path('SKILL.md') for path, _, _ in files), 'Missing SKILL.md')
        with tempfile.TemporaryDirectory(prefix='.verified-skill-', dir=target) as temporary:
            staged = Path(temporary) / name
            staged.mkdir()
            for relative, mode, blob in files:
                dest = staged / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                data = subprocess.check_output(['git', '-C', str(checkout), 'cat-file', 'blob', blob])
                dest.write_bytes(data)
                dest.chmod(0o755 if mode == '100755' else 0o644)
            destination = target / name
            if destination.is_symlink():
                destination.unlink()
            elif destination.exists():
                shutil.rmtree(destination)
            staged.rename(destination)
    # This is a dedicated managed directory, not a general-purpose skill home.
    for old in target.glob('rpi-*'):
        if old.name not in skills:
            if old.is_symlink():
                old.unlink()
            elif old.is_dir():
                shutil.rmtree(old)


def deploy(checkout, sha, skill_target):
    standalone(checkout)
    # The lock lives outside the worktree cleaned below and serializes operators.
    with (checkout / '.git/verified-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        git(checkout, 'fetch', '--no-tags', '--prune', 'origin',
            '+refs/heads/main:refs/remotes/origin/main')
        verify_main(checkout, sha)
        evidence = verify_remote(sha)
        record = {'sha': sha, **evidence, 'checkout': str(checkout),
                  'skills': str(skill_target), 'units': UNITS}
        log_path = checkout / '.git/verified-deploy.jsonl'

        def log(status):
            row = record | {'status': status, 'at': datetime.datetime.now(
                datetime.timezone.utc).isoformat()}
            with log_path.open('a') as output:
                output.write(json.dumps(row) + '\n')
                output.flush()
                os.fsync(output.fileno())
            print(json.dumps(row), flush=True)

        log('verified')
        try:
            # Stop readers before mutating their working directory.
            command('systemctl', '--user', 'stop', *UNITS)
            git(checkout, 'reset', '--hard', 'HEAD')
            git(checkout, 'clean', '-ffdx', '-e', 'node_modules')
            git(checkout, 'checkout', '--force', '--detach', sha)
            git(checkout, 'reset', '--hard', sha)
            git(checkout, 'clean', '-ffdx', '-e', 'node_modules')
            subprocess.run(['bun', 'install', '--frozen-lockfile'], cwd=checkout, check=True)
            copy_skills(checkout, sha, skill_target)
            command('systemctl', '--user', 'restart', *UNITS)
            command('systemctl', '--user', 'is-active', '--quiet', *UNITS)
            log('deployed')
        except Exception:
            log('failed')
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sha', help='full merge-result SHA on origin/main')
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--skills', type=Path, required=True,
                        help='dedicated operator-owned directory for verified RPI copies')
    args = parser.parse_args()
    # Do not inherit Git redirection or agent-selected configuration.
    for name in list(os.environ):
        if name.startswith('GIT_'):
            del os.environ[name]
    os.environ.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                      GIT_TERMINAL_PROMPT='0')
    checkout = args.checkout.resolve()
    require(not args.skills.is_symlink(), 'Skill destination must not be a symlink')
    target = args.skills.resolve()
    require(not target.is_relative_to(checkout) and not checkout.is_relative_to(target),
            'Skill directory must be separate from the deployment checkout')
    deploy(checkout, args.sha, target)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError, TypeError) as error:
        print(f'deployment refused or failed: {error}', file=sys.stderr)
        sys.exit(1)
