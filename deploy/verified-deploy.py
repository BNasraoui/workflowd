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
import stat
import subprocess
import sys
import tempfile

REPO = 'BNasraoui/workflowd'
REMOTE = f'https://github.com/{REPO}.git'
DEPLOY_STATE = Path('/opt/workflowd/operator/last-deployed')
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


def verify_approval(pr, checks, sha, app_id):
    require(pr.get('merged_at') and pr.get('merge_commit_sha') == sha
            and pr.get('base', {}).get('ref') == 'main'
            and pr.get('base', {}).get('repo', {}).get('full_name') == REPO,
            'Target must be the merge result of a PR into this repository main')
    candidates = [row for row in checks if row.get('name') == 'Ben approval'
                  and row.get('app', {}).get('id') == app_id]
    require(candidates, 'Ben approval from the configured merge gate App is missing')
    approval = max(candidates, key=lambda row: row['id'])
    require(approval.get('head_sha') == pr['head']['sha']
            and approval.get('status') == 'completed'
            and approval.get('conclusion') == 'success',
            'Latest Ben approval must succeed for the final PR head')
    return approval


def command(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE).stdout.strip()


def git(checkout, *args):
    return command('git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                   '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
                   '-C', str(checkout), *args)


def api(endpoint, key=None):
    output = command('gh', 'api', '--hostname', 'github.com', '--paginate',
                     f'repos/{REPO}/{endpoint}')
    require(output, 'Empty GitHub response')
    rows = []
    decoder = json.JSONDecoder()
    while output:
        page, end = decoder.raw_decode(output.lstrip())
        batch = page[key] if key else page
        require(isinstance(batch, list), 'Invalid GitHub list response')
        rows.extend(batch)
        output = output.lstrip()[end:].lstrip()
    return rows


def verify_remote(sha, app_id):
    checks = api(f'commits/{sha}/check-runs?filter=all&per_page=100', 'check_runs')
    check = verify_checks(checks, sha)
    runs = api(f'actions/workflows/ci.yml/runs?head_sha={sha}&event=push&per_page=100',
               'workflow_runs')
    run = verify_workflow(runs, check, sha)
    for pr in api(f'commits/{sha}/pulls?per_page=100'):
        if pr.get('merge_commit_sha') != sha or not pr.get('merged_at'):
            continue
        approvals = api(f'commits/{pr["head"]["sha"]}/check-runs?filter=all&per_page=100',
                        'check_runs')
        approval = verify_approval(pr, approvals, sha, app_id)
        return {'sha': sha, 'pr': pr['number'], 'pr_head': pr['head']['sha'],
                'approval_id': approval['id'], 'approval_app_id': app_id,
                'check_id': check['id'], 'run_id': run['id']}
    raise ValueError('No merged PR found for the exact deployment SHA')


def standalone(checkout):
    metadata = checkout / '.git'
    require(metadata.is_dir() and not metadata.is_symlink(),
            'Deployment requires a standalone clone with its own .git directory')
    config = git(checkout, 'config', '--local', '--no-includes', '--null', '--list')
    for entry in config.split('\0'):
        key = entry.split('\n', 1)[0].lower()
        require(not key.startswith(('include', 'filter.', 'credential.', 'http.', 'url.'))
                and key != 'core.fsmonitor' and key != 'extensions.worktreeconfig',
                f'Unsafe local Git config: {key}')
    attributes = metadata / 'info/attributes'
    require(not attributes.exists() and not attributes.is_symlink(),
            'Local .git/info/attributes is forbidden')
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


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_mode & 0o077 == 0,
            f'{path} must be a private operator-owned regular file')
    return path.read_text().strip()


def require_state_directory(state):
    parent = state.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid()
            and parent.st_mode & 0o022 == 0,
            'Deployment state directory must be operator-owned and not writable by others')


def deployment_commits(checkout, sha, state, bootstrap):
    require_state_directory(state)
    if not state.exists() and not state.is_symlink():
        require(bootstrap, 'Missing deployment state; operator must explicitly --bootstrap')
        return [sha]
    previous = private_file(state)
    require(re.fullmatch(r'[0-9a-f]{40}', previous), 'Invalid last deployed SHA')
    try:
        git(checkout, 'merge-base', '--is-ancestor', previous, sha)
    except subprocess.CalledProcessError as error:
        require(bootstrap, 'Last deployed SHA is not an ancestor; explicit --bootstrap required')
        require(error.returncode in (1, 128), 'Cannot determine deployment ancestry')
        return [sha]
    return git(checkout, 'rev-list', '--first-parent', '--reverse',
               f'{previous}..{sha}').splitlines() or [sha]


def require_skill_target(target):
    marker = target / '.workflowd-verified-skills'
    require(not target.is_symlink() and marker.is_file() and not marker.is_symlink(),
            'Dedicated skill directory requires .workflowd-verified-skills marker')


def write_state(state, sha):
    with tempfile.NamedTemporaryFile(mode='w', dir=state.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(sha + '\n')
            output.flush()
            os.fsync(output.fileno())
            temporary.replace(state)
        finally:
            temporary.unlink(missing_ok=True)
    directory = os.open(state.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def copy_skills(checkout, sha, target):
    """Read blobs from the verified commit, never from checkout skill symlinks."""
    require_skill_target(target)
    entries = git(checkout, 'ls-tree', '-rz', sha, '--', 'skills').split('\0')
    skills = {}
    for entry in entries:
        if not entry:
            continue
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


def deploy(checkout, sha, skill_target, state, app_id, bun, bootstrap=False):
    standalone(checkout)
    require_skill_target(skill_target)
    # The lock lives outside the worktree cleaned below and serializes operators.
    with (checkout / '.git/verified-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        git(checkout, 'fetch', '--no-tags', '--prune', 'origin',
            '+refs/heads/main:refs/remotes/origin/main')
        verify_main(checkout, sha)
        commits = deployment_commits(checkout, sha, state, bootstrap)
        evidence = [verify_remote(commit, app_id) for commit in commits]
        record = {'sha': sha, 'evidence': evidence, 'bootstrap': bootstrap,
                  'previous_sha': private_file(state) if state.exists() else None,
                  'state': str(state), 'checkout': str(checkout),
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
            git(checkout, 'clean', '-ffdx', '-e', '/node_modules')
            git(checkout, 'checkout', '--force', '--detach', sha)
            git(checkout, 'reset', '--hard', sha)
            git(checkout, 'clean', '-ffdx', '-e', '/node_modules')
            subprocess.run([str(bun), 'install', '--frozen-lockfile', '--no-cache',
                            '--backend=copyfile'], cwd=checkout, check=True)
            copy_skills(checkout, sha, skill_target)
            command('systemctl', '--user', 'restart', *UNITS)
            command('systemctl', '--user', 'is-active', '--quiet', *UNITS)
            log('deployed')
            write_state(state, sha)
        except Exception:
            log('failed')
            raise


def check_toolchain(bun):
    require(sys.version_info >= (3, 9), 'Python version 3.9+ is required')
    versions = {'python': sys.version.split()[0]}
    for executable, minimum in [('git', (2, 34, 0)), ('gh', (2, 45, 0)),
                                (str(bun), (1, 3, 14))]:
        output = command(executable, '--version').splitlines()[0]
        match = re.search(r'\b(\d+)\.(\d+)\.(\d+)\b', output)
        require(match, f'Unrecognized {executable} version')
        version = tuple(map(int, match.groups()))
        require(version == minimum if executable == str(bun) else version >= minimum,
                f'Unsupported {executable} version: {output}')
        versions[executable] = output
    print(json.dumps({'tool_versions': versions}), flush=True)


def configure_environment(token_file, isolated_home):
    token = private_file(token_file)
    require(token and not any(char.isspace() for char in token), 'Invalid deploy token file')
    os.environ.clear()
    os.environ.update(PATH='/usr/bin:/bin', HOME=str(isolated_home),
                      XDG_CONFIG_HOME=str(isolated_home), GH_CONFIG_DIR=str(isolated_home),
                      GH_TOKEN=token, GH_PROMPT_DISABLED='1',
                      GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                      GIT_TERMINAL_PROMPT='0',
                      XDG_RUNTIME_DIR=f'/run/user/{os.geteuid()}',
                      DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{os.geteuid()}/bus')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sha', help='full merge-result SHA on origin/main')
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--skills', type=Path, required=True,
                        help='dedicated operator-owned directory with managed marker')
    parser.add_argument('--github-token-file', type=Path, required=True)
    parser.add_argument('--approval-app-id', type=int, required=True,
                        help='merge gate App integration ID, not installation ID')
    parser.add_argument('--bun', type=Path, required=True, help='absolute pinned Bun executable')
    parser.add_argument('--bootstrap', action='store_true',
                        help='explicitly trust history before target; target still needs approval and CI')
    args = parser.parse_args()
    require(args.approval_app_id > 0, 'A positive merge gate App ID is required')
    require(args.bun.is_absolute(), 'Bun path must be absolute')
    checkout = args.checkout.resolve()
    require_skill_target(args.skills)
    target = args.skills.resolve()
    require(not target.is_relative_to(checkout) and not checkout.is_relative_to(target),
            'Skill directory must be separate from the deployment checkout')
    for path in (DEPLOY_STATE, args.github_token_file, args.bun):
        require(path.is_absolute() and not path.is_symlink(), 'Use absolute non-symlink operator paths')
        require(not path.resolve().is_relative_to(checkout)
                and not path.resolve().is_relative_to(target),
                'State, credentials and Bun must be outside checkout and skills')
    require(DEPLOY_STATE != args.github_token_file.resolve() and DEPLOY_STATE != args.bun.resolve(),
            'State must have its own path')
    # The whole child environment is replaced, including inherited proxies,
    # tokens, Bun/npm overrides and global gh/Bun configuration paths.
    require_state_directory(DEPLOY_STATE)
    with tempfile.TemporaryDirectory(prefix='.deploy-home-', dir=DEPLOY_STATE.parent) as isolated:
        configure_environment(args.github_token_file, Path(isolated))
        check_toolchain(args.bun)
        deploy(checkout, args.sha, target, DEPLOY_STATE, args.approval_app_id,
               args.bun, args.bootstrap)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError, TypeError) as error:
        print(f'deployment refused or failed: {error}', file=sys.stderr)
        sys.exit(1)
