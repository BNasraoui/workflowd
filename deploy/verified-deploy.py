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
PROC_ROOT = Path('/proc')


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
    require(app_id != 15368, 'GitHub Actions cannot be the approval App')
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


def command(*args, cwd=None, token=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          env=os.environ | {'GH_TOKEN': token} if args[0] == 'gh' and token else None,
                          stdout=subprocess.PIPE).stdout.strip()


def git(checkout, *args):
    return command('git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                   '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
                   '-c', 'advice.graftFileDeprecated=false', '-c', 'fetch.fsckObjects=true',
                   '-C', str(checkout), *args)


def api(endpoint, key=None, token=None):
    output = command('gh', 'api', '--hostname', 'github.com', '--paginate',
                     f'repos/{REPO}/{endpoint}', token=token)
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


def verify_remote(sha, app_id, token=None):
    checks = api(f'commits/{sha}/check-runs?filter=all&per_page=100', 'check_runs', token=token)
    check = verify_checks(checks, sha)
    runs = api(f'actions/workflows/ci.yml/runs?head_sha={sha}&event=push&per_page=100',
               'workflow_runs', token=token)
    run = verify_workflow(runs, check, sha)
    for pr in api(f'commits/{sha}/pulls?per_page=100', token=token):
        if pr.get('merge_commit_sha') != sha or not pr.get('merged_at'):
            continue
        approvals = api(f'commits/{pr["head"]["sha"]}/check-runs?filter=all&per_page=100',
                        'check_runs', token=token)
        approval = verify_approval(pr, approvals, sha, app_id)
        commit = json.loads(command('gh', 'api', '--hostname', 'github.com',
                                    f'repos/{REPO}/commits/{sha}', token=token))
        tree = commit['commit']['tree']['sha']
        require(re.fullmatch(r'[0-9a-f]{40}', tree), 'Invalid GitHub commit tree SHA')
        return {'sha': sha, 'tree': tree, 'pr': pr['number'], 'pr_head': pr['head']['sha'],
                'approval_id': approval['id'], 'approval_app_id': app_id,
                'check_id': check['id'], 'run_id': run['id']}
    raise ValueError('No merged PR found for the exact deployment SHA')


def standalone(checkout):
    metadata = checkout / '.git'
    require(metadata.is_dir() and not metadata.is_symlink(),
            'Deployment requires a standalone clone with its own .git directory')
    for relative in ('refs/replace', 'info/grafts', 'info/sparse-checkout', 'info/attributes'):
        path = metadata / relative
        require(not path.exists() and not path.is_symlink(),
                f'Local .git/{relative} is forbidden')
    allowed = {'core.repositoryformatversion', 'core.filemode', 'core.bare',
               'core.logallrefupdates', 'core.hookspath',
               'remote.origin.url', 'remote.origin.fetch'}
    config = git(checkout, 'config', '--local', '--no-includes', '--null', '--list')
    for entry in filter(None, config.split('\0')):
        key = entry.split('\n', 1)[0].lower()
        require(key in allowed, f'Unsafe local Git config: {key}')
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
                data = subprocess.check_output(['git', '-c', 'advice.graftFileDeprecated=false',
                                                '-C', str(checkout), 'cat-file', 'blob', blob])
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


def append_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
                             0o600), 'a')


def release_layout(checkout, *, create=True):
    """Inspect only directory/link metadata, never a retained release's Git data."""
    require_state_directory(checkout)
    releases = checkout.parent / 'releases'
    if create:
        releases.mkdir(mode=0o700, exist_ok=True)
    info = releases.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_mode & 0o077 == 0, 'Releases must be a private operator-owned directory')
    previous_link = checkout.parent / 'previous'
    require(previous_link.is_symlink() or not previous_link.exists(),
            'Previous must be absent or a symlink')
    previous = None
    if checkout.exists() or checkout.is_symlink():
        require(checkout.is_symlink(), 'Checkout must be absent or a release symlink; migrate the old clone')
        previous = checkout.resolve(strict=True)
        require(previous.parent == releases and previous.is_dir(),
                'Checkout must point directly to a retained release directory')
    return releases, previous


def require_unused_releases(candidates):
    """Inspect unit configuration and live process paths while holding the deploy lock."""
    def check_path(value, source):
        path = Path(value).resolve()
        for candidate in candidates:
            require(not path.is_relative_to(candidate),
                    f'Release in use by {source}: {candidate}')

    def check_process(process):
        for name in ('cwd', 'exe', 'root'):
            try:
                target = os.readlink(process / name)
            except (FileNotFoundError, ProcessLookupError):
                continue  # Process exited, or has no executable (for example a zombie).
            check_path(target.removesuffix(' (deleted)'), f'{process}/{name}')

    for unit in UNITS:
        output = command('systemctl', '--user', 'show', '-p', 'MainPID',
                         '-p', 'ExecStart', '-p', 'WorkingDirectory', unit)
        properties = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        require(all(key in properties for key in ('MainPID', 'ExecStart', 'WorkingDirectory')),
                f'Cannot inspect unit properties: {unit}')
        require(properties['MainPID'].isdigit(), f'Invalid MainPID: {unit}')
        if int(properties['MainPID']):
            check_process(PROC_ROOT / properties['MainPID'])
        if properties['WorkingDirectory']:
            check_path(properties['WorkingDirectory'], f'{unit} WorkingDirectory')
        # systemctl renders ExecStart as structured text containing path= and argv[]=.
        # Check absolute paths in both fields, including escaped whitespace. Also
        # check prefixes at spaces because the display may leave argv unquoted.
        value = re.sub(r'\\x([0-9a-fA-F]{2})', lambda m: chr(int(m[1], 16)),
                       properties['ExecStart'])
        for start in re.finditer(r'(?:^|[\s=])(?=/)', value):
            tail = re.split(r'[;{}\n]', value[start.end():], maxsplit=1)[0].rstrip()
            for end in [m.start() for m in re.finditer(r'\s', tail)] + [len(tail)]:
                check_path(tail[:end], f'{unit} ExecStart')

    for process in PROC_ROOT.iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid == os.geteuid():
                check_process(process)
        except (FileNotFoundError, ProcessLookupError):
            continue  # The process exited between listing /proc and inspection.


def prune_releases(checkout, state, names):
    """Delete explicit unused releases; the operator must first drain their users."""
    require_state_directory(state)
    with append_file(state.parent / 'verified-deploy.lock') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        releases, current = release_layout(checkout, create=False)
        protected = {current}
        previous = checkout.parent / 'previous'
        if previous.is_symlink():
            target = previous.resolve(strict=True)
            require(target.parent == releases and target.is_dir(),
                    'Previous must point directly to a retained release directory')
            protected.add(target)
        candidates = []
        for name in dict.fromkeys(names):
            require(name not in ('', '.', '..') and Path(name).name == name,
                    'Prune requires release directory names, not paths')
            candidate = releases / name
            require(not candidate.is_symlink() and candidate.is_dir(),
                    'Prune requires a real release directory')
            require(candidate not in protected, 'Cannot prune current or previous release')
            candidates.append(candidate)
        # Validate the entire request before removing anything.
        require_unused_releases(candidates)
        for candidate in candidates:
            shutil.rmtree(candidate)
            print(json.dumps({'pruned_release': str(candidate)}), flush=True)


def deploy(checkout, sha, skill_target, state, app_id, bun, bootstrap=False, token=None):
    require(re.fullmatch(r'[0-9a-f]{40}', sha), 'Use a full lowercase commit SHA')
    require_skill_target(skill_target)
    require_state_directory(state)
    # Stable operator state, independent of all current and retained releases.
    with append_file(state.parent / 'verified-deploy.lock') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        releases, previous = release_layout(checkout)
        release = Path(tempfile.mkdtemp(prefix=sha[:12] + '-', dir=releases))
        activated = False
        record = None

        def log(status):
            row = record | {'status': status, 'at': datetime.datetime.now(
                datetime.timezone.utc).isoformat()}
            with append_file(state.parent / 'verified-deploy.jsonl') as output:
                output.write(json.dumps(row) + '\n')
                output.flush()
                os.fsync(output.fileno())
            print(json.dumps(row), flush=True)

        try:
            (release / '.git').mkdir(mode=0o700)
            git(release, 'init', '--quiet', '--template=', '--initial-branch=main')
            git(release, 'remote', 'add', 'origin', REMOTE)
            standalone(release)
            git(release, 'fetch', '--no-tags', REMOTE,
                '+refs/heads/main:refs/remotes/origin/main', sha)
            verify_main(release, sha)
            commits = deployment_commits(release, sha, state, bootstrap)
            evidence = [verify_remote(commit, app_id, token=token) for commit in commits]
            record = {'sha': sha, 'evidence': evidence, 'bootstrap': bootstrap,
                      'previous_sha': private_file(state) if state.exists() else None,
                      'state': str(state), 'checkout': str(checkout), 'release': str(release),
                      'previous_release': str(previous) if previous else None,
                      'skills': str(skill_target), 'units': UNITS}
            log('verified')
            git(release, 'checkout', '--force', '--detach', sha)
            git(release, 'fsck', '--full', '--strict', '--no-dangling')
            require(git(release, 'rev-parse', 'HEAD^{tree}') == evidence[-1]['tree'],
                    'Checked-out tree differs from the GitHub commit tree')
            dependencies = release / 'node_modules'
            if dependencies.is_symlink() or dependencies.is_file():
                dependencies.unlink()
            elif dependencies.exists():
                shutil.rmtree(dependencies)
            subprocess.run([str(bun), 'install', '--frozen-lockfile', '--no-cache',
                            '--backend=copyfile'], cwd=release, check=True)
            # All Git reads, including skill blobs, use this fresh object store.
            copy_skills(release, sha, skill_target)
            with tempfile.TemporaryDirectory(prefix='.activate-', dir=checkout.parent) as directory:
                staged_current = Path(directory) / 'current'
                staged_previous = Path(directory) / 'previous'
                staged_current.symlink_to(release, target_is_directory=True)
                if previous:
                    staged_previous.symlink_to(previous, target_is_directory=True)
                command('systemctl', '--user', 'stop', *UNITS)
                if previous:
                    staged_previous.replace(checkout.parent / 'previous')
                staged_current.replace(checkout)
                activated = True
                command('systemctl', '--user', 'restart', *UNITS)
                command('systemctl', '--user', 'is-active', '--quiet', *UNITS)
            descriptor = os.open(checkout.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            log('deployed')
            write_state(state, sha)
        except Exception:
            if record is not None:
                log('failed')
            raise
        finally:
            # A post-activation failure retains both releases for operator recovery.
            if not activated and checkout.resolve() != release:
                shutil.rmtree(release)


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
                      GH_PROMPT_DISABLED='1',
                      GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                      GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1',
                      GIT_GRAFT_FILE='/dev/null',
                      XDG_RUNTIME_DIR=f'/run/user/{os.geteuid()}',
                      DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{os.geteuid()}/bus')
    return token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sha', nargs='?', help='full merge-result SHA on origin/main')
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--prune', nargs='+', metavar='RELEASE',
                        help='remove named unused releases under the deployment lock')
    parser.add_argument('--skills', type=Path,
                        help='dedicated operator-owned directory with managed marker')
    parser.add_argument('--github-token-file', type=Path)
    parser.add_argument('--approval-app-id', type=int,
                        help='merge gate App integration ID, not installation ID')
    parser.add_argument('--bun', type=Path, help='absolute pinned Bun executable')
    parser.add_argument('--bootstrap', action='store_true',
                        help='explicitly trust history before target; target still needs approval and CI')
    args = parser.parse_args()
    require(args.checkout.is_absolute(), 'Checkout path must be absolute')
    checkout = args.checkout.parent.resolve() / args.checkout.name
    require(checkout.name not in ('releases', 'previous'), 'Reserved checkout name')
    if args.prune:
        require(not args.bootstrap and all(value is None for value in
                (args.sha, args.skills, args.github_token_file, args.approval_app_id, args.bun)),
                'Prune cannot be combined with deployment arguments')
        prune_releases(checkout, DEPLOY_STATE, args.prune)
        return
    if any(value is None for value in (args.sha, args.skills, args.github_token_file,
                                       args.approval_app_id, args.bun)):
        parser.error('deployment requires sha, --skills, --github-token-file, --approval-app-id and --bun')
    require(args.approval_app_id != 15368, 'GitHub Actions cannot be the approval App')
    require(args.approval_app_id > 0, 'A positive merge gate App ID is required')
    require(args.bun.is_absolute(), 'Bun path must be absolute')
    require_skill_target(args.skills)
    target = args.skills.resolve()
    require(not target.is_relative_to(checkout.parent) and not checkout.parent.is_relative_to(target),
            'Skill directory must be separate from the deployment checkout')
    for path in (DEPLOY_STATE, args.github_token_file, args.bun):
        require(path.is_absolute() and not path.is_symlink(), 'Use absolute non-symlink operator paths')
        require(not path.resolve().is_relative_to(checkout.parent)
                and not path.resolve().is_relative_to(target),
                'State, credentials and Bun must be outside checkout and skills')
    require(DEPLOY_STATE != args.github_token_file.resolve() and DEPLOY_STATE != args.bun.resolve(),
            'State must have its own path')
    # The whole child environment is replaced, including inherited proxies,
    # tokens, Bun/npm overrides and global gh/Bun configuration paths.
    require_state_directory(DEPLOY_STATE)
    with tempfile.TemporaryDirectory(prefix='.deploy-home-', dir=DEPLOY_STATE.parent) as isolated:
        token = configure_environment(args.github_token_file, Path(isolated))
        check_toolchain(args.bun)
        deploy(checkout, args.sha, target, DEPLOY_STATE, args.approval_app_id,
               args.bun, args.bootstrap, token=token)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError, TypeError) as error:
        print(f'deployment refused or failed: {error}', file=sys.stderr)
        sys.exit(1)
