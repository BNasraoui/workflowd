#!/usr/bin/env python3
"""Runner result sealing. Only metadata is returned over the control connection."""
import hashlib
import json
import os
import re
import stat
import unicodedata
import zipfile
import signal
import resource
import tempfile
from pathlib import Path
import subprocess
import sys


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    def bounds():
        resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024**2, 128 * 1024**2))
    with tempfile.TemporaryFile() as output:
        subprocess.run(
            ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
             '-c', 'core.attributesFile=/dev/null', '-C', repo, *args],
            env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
                 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0'},
            stdout=output, stderr=subprocess.DEVNULL, timeout=60,
            check=True, preexec_fn=bounds)
        assert output.tell() <= 16 * 1024**2, 'Git inventory exceeded bound'
        output.seek(0)
        return output.read()


def seal(repo, directory, source):
    raw = sys.stdin.buffer.read(65537)
    assert len(raw) <= 65536
    completion = json.loads(raw)
    assert set(completion) == {'branch'} and isinstance(completion['branch'], str)
    # No branch predicate: the name never participates in a Git command or path.
    refs = git(repo, 'for-each-ref', '--format=%(objectname)',
               'refs/remotes/container-use/').decode().splitlines()
    assert len(refs) == 1, 'Missing or ambiguous container-use result'
    result = refs[0]
    assert git(repo, 'cat-file', '-t', result).strip() == b'commit'
    assert git(repo, 'rev-parse', source + '^{commit}').decode().strip() == source
    if git(repo, 'rev-parse', source + '^{tree}') == git(repo, 'rev-parse', result + '^{tree}'):
        print(json.dumps({'empty': True, 'sourceSha': source}))
        return
    git(repo, 'merge-base', '--is-ancestor', source, result)
    root = Path(directory)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    bundle = root / 'result.bundle'
    # A fixed advertised head avoids exposing container-use refs or the agent name.
    git(repo, 'update-ref', 'refs/workflowd/result', result)
    git(repo, 'bundle', 'create', str(bundle), 'refs/workflowd/result', '^' + source)
    assert bundle.stat().st_size <= 16 * 1024 * 1024
    manifest = {'sourceSha': source, 'resultSha': result, 'branch': completion['branch'],
                'bundleSha256': sha(bundle.read_bytes())}
    encoded = json.dumps(manifest, ensure_ascii=True, separators=(',', ':')).encode()
    assert len(encoded) <= 65536
    (root / 'result.json').write_bytes(encoded)
    print(json.dumps({**manifest, 'manifestSha256': sha(encoded)}, separators=(',', ':')))


def safe_path(raw):
    name = raw.decode('utf8', errors='strict')
    parts = name.split('/')
    assert not any(p in ('', '.', '..') or p.lower().startswith('.git') for p in parts)
    assert not name.startswith('deploy/sandbox/') and name != 'deploy/sandbox'
    assert '\\' not in name and not any(ord(c) < 32 for c in name)
    assert unicodedata.normalize('NFC', name) == name
    return name.casefold()


def inspect_changes(repo, source, result):
    commits = git(repo, 'rev-list', '--reverse', source + '..' + result).decode().splitlines()
    assert 1 <= len(commits) <= 100
    objects = git(repo, 'rev-list', '--objects', source + '..' + result).splitlines()
    assert len(objects) <= 10000
    total = 0
    for obj in objects:
        total += int(git(repo, 'cat-file', '-s', obj.split(b' ')[0].decode()))
        assert total <= 64 * 1024 * 1024
    parent = source
    content = 0
    changed = set()
    for commit in commits:
        assert git(repo, 'rev-list', '--parents', '-n', '1', commit).decode().split() == [commit, parent]
        entries = git(repo, 'diff-tree', '-r', '--raw', '--no-renames', '-z', parent, commit).split(b'\0')
        assert entries[-1] == b''
        entries.pop()
        assert len(entries) % 2 == 0
        for i in range(0, len(entries), 2):
            fields = entries[i].decode('ascii').split()
            assert len(fields) == 5
            old, new, _, blob, _ = fields
            old = old.removeprefix(':')
            path = entries[i + 1]
            safe_path(path)
            changed.add(path)
            assert len(changed) <= 100
            assert old in ('000000', '100644', '100755') and new in ('000000', '100644', '100755')
            assert new == '000000' or (new == '100644' if old == '000000' else old == new)
            if new != '000000':
                size = int(git(repo, 'cat-file', '-s', blob))
                assert size <= 1024 * 1024
                content += size
                assert content <= 8 * 1024 * 1024
        # Detect case/normalization collisions against the complete tree, including base paths.
        names = git(repo, 'ls-tree', '-r', '-z', '--name-only', commit).split(b'\0')[:-1]
        folded = {}
        for name in names:
            key = unicodedata.normalize('NFC', name.decode('utf8')).casefold()
            if name in changed:
                assert key not in folded or folded[key] == name
            if key in folded and folded[key] in changed:
                assert folded[key] == name
            folded[key] = name
        parent = commit
    assert parent == result


def validate(archive, source_url, directory):
    binding = json.loads(sys.stdin.buffer.read(65537))
    for key in ('source', 'result'):
        assert re.fullmatch('[a-f0-9]{40}', binding[key])
    path = Path(archive)
    assert path.stat().st_size <= 16 * 1024 * 1024
    assert 'sha256:' + sha(path.read_bytes()) == binding['digest']
    root = Path(directory)
    root.mkdir(mode=0o700, parents=True)
    with zipfile.ZipFile(path) as zipped:
        entries = zipped.infolist()
        assert len(entries) == 2 and {e.filename for e in entries} == {'result.json', 'result.bundle'}
        assert sum(e.file_size for e in entries) <= 64 * 1024 * 1024
        for entry in entries:
            mode = entry.external_attr >> 16
            assert not mode or stat.S_IFMT(mode) in (0, stat.S_IFREG)
            assert entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            assert not entry.flag_bits & 1
            assert entry.file_size <= (65536 if entry.filename == 'result.json' else 64 * 1024 * 1024)
            data = zipped.read(entry)
            assert len(data) == entry.file_size
            (root / entry.filename).write_bytes(data)
    raw = (root / 'result.json').read_bytes()
    assert sha(raw) == binding['manifest']
    manifest = json.loads(raw)
    assert set(manifest) == {'sourceSha', 'resultSha', 'branch', 'bundleSha256'}
    assert isinstance(manifest['branch'], str)
    assert manifest['sourceSha'] == binding['source'] and manifest['resultSha'] == binding['result']
    bundle = root / 'result.bundle'
    assert sha(bundle.read_bytes()) == manifest['bundleSha256']
    repo = str(root / 'objects.git')
    git(str(root), 'init', '--bare', repo)
    git(repo, '-c', 'credential.helper=', '-c', 'http.extraHeader=', 'fetch', '--no-tags', '--', source_url, binding['source'])
    before = set(git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').splitlines())
    heads = git(repo, 'bundle', 'list-heads', str(bundle)).decode().splitlines()
    assert heads == [binding['result'] + ' refs/workflowd/result']
    git(repo, 'bundle', 'verify', str(bundle))
    git(repo, 'fetch', '--no-tags', '--', str(bundle), 'refs/workflowd/result')
    inventory = git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objectsize)').splitlines()
    added = [line.split() for line in inventory if line.split()[0] not in before]
    assert len(added) <= 10000 and sum(int(fields[1]) for fields in added) <= 64 * 1024**2
    git(repo, 'fsck', '--strict', '--no-reflogs', binding['result'])
    inspect_changes(repo, binding['source'], binding['result'])
    print(json.dumps(manifest, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        signal.alarm(180)
        if sys.argv[1] == 'seal': seal(*sys.argv[2:])
        elif sys.argv[1] == 'validate': validate(*sys.argv[2:])
        else: raise ValueError('Unknown operation')
    except Exception:
        sys.exit('Sandbox result sealing failed')
