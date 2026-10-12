#!/usr/bin/env python3
"""Runner result sealing. Only metadata is returned over the control connection."""
import base64
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


def commit_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{40}', value):
        raise ValueError('Invalid commit identity')
    return value


def git(repo, *args):
    def bounds():
        resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024**2, 128 * 1024**2))
    with tempfile.TemporaryFile() as output:
        # S8705 / AaEZv6-2dwEzUswl_4bM follows source through commit_id() into
        # fetch after '--'. A fullmatched 40-character lowercase hex ID cannot
        # be an option. No shell is used; URL operands follow '--' and only
        # HTTPS/file transports are enabled. See the documented false-positive
        # review and the source/result-option and external-helper regressions.
        subprocess.run(  # NOSONAR -- S8705: validated commit ID, not an option
            ['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
             '-c', 'core.attributesFile=/dev/null', *args], cwd=repo,
            env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
                 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0',
                 'GIT_ALLOW_PROTOCOL': 'https:file'},
            stdout=output, stderr=subprocess.DEVNULL, timeout=60,
            check=True, preexec_fn=bounds)
        assert output.tell() <= 16 * 1024**2, 'Git inventory exceeded bound'
        output.seek(0)
        return output.read()


# The corpus pins the policy to Unicode 15.0; never silently use another UCD.
UNICODE = json.loads(Path(__file__).with_name('publication-unicode.json').read_text())
if UNICODE['version'] != '15.0.0' or unicodedata.unidata_version != UNICODE['version']:
    raise RuntimeError('Unsupported publication Unicode runtime')
CASEFOLD = json.loads(Path(__file__).with_name('casefold.json').read_text())
INVISIBLE = re.compile('[' + UNICODE['forbidden'] + ']')
LETTERS = re.compile('[' + UNICODE['letters'] + ']')
STACKED_MARKS = re.compile('[' + UNICODE['marks'] + ']{3}')
LANGUAGES = {'', 'text', 'diff', 'ts', 'typescript', 'tsx', 'js', 'json', 'sh', 'bash', 'python', 'rust', 'go', 'sql', 'yaml', 'toml'}
CLOSING = re.compile(r'(?=(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:#[0-9]|gh-[0-9]|[a-z0-9_.-]+/[a-z0-9_.-]+#|https?://|github\.com/[^\s]*/(?:issues|pull)/))')


def safe_publication(value):
    if INVISIBLE.search(value):
        raise ValueError('Invisible publication content')
    if not all(unicodedata.category(c) not in ('Cc', 'Cf') or c == '\n' for c in value):
        raise ValueError('Invalid publication text')
    if re.search(r'&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);', value):
        raise ValueError('Character reference')
    if STACKED_MARKS.search(unicodedata.normalize('NFD', value)):
        raise ValueError('Stacked combining marks')
    normalized = ''.join(CASEFOLD.get(c, c) for c in unicodedata.normalize('NFKC', value))
    for separator in ('', ' '):
        folded = re.sub(r'[*_~`\[\]()]', separator, normalized)
        if any(m.start() == 0 or not LETTERS.fullmatch(folded[m.start() - 1]) for m in CLOSING.finditer(folded)):
            raise ValueError('Closing issue reference')
    fence = None
    blank = True
    for line in value.split('\n'):
        if re.match(r'^ +(?:`{3,}|~{3,})', line):
            raise ValueError('Indented fence')
        if fence is not None:
            if line == fence: fence = None
            elif re.match(r'^ {0,3}(?:`{3,}|~{3,})', line):
                raise ValueError('Ambiguous fence')
        else:
            if ']:' in line:
                raise ValueError('Link reference definition')
            if re.match(r'^ {0,3}(?:> ?|(?:[-+*]|[0-9]+[.)]) +).*(?:`{3,}|~{3,})', line):
                raise ValueError('Nested fence')
            opener = re.fullmatch(r'(`{3,}|~{3,})(.*)', line)
            if opener:
                if not blank or opener[2] not in LANGUAGES:
                    raise ValueError('Invalid fence opening')
                fence = opener[1]
            elif re.search(r'[<@$\\]', line):
                raise ValueError('HTML, mention, math or backslash outside fence')
        blank = re.fullmatch(' *', line) is not None
    if fence is not None:
        raise ValueError('Unclosed fence')


def publication_text(value, message=False):
    if not isinstance(value, str) or not value:
        raise ValueError('Invalid publication text')
    encoded = value.encode('utf8', errors='strict')
    if (len(encoded) > 10240) if message else (len(value) > 200):
        raise ValueError('Invalid publication text')
    if not all(unicodedata.category(c) not in ('Cc', 'Cf') or (message and c == '\n') for c in value):
        raise ValueError('Invalid publication text')
    if not message and any(c in value for c in ('\u2028', '\u2029')):
        raise ValueError('Invalid publication text')
    safe_publication(value)


def publication_body(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('body must be non-empty Markdown')
    if len(value.encode('utf8', errors='strict')) > 32768:
        raise ValueError('body exceeds 32 KiB UTF-8')
    safe_publication(value)


def seal(source):
    # The control entrypoint selects the workspace; no caller-supplied paths.
    repo = 'repository'
    source = commit_id(source)
    raw = sys.stdin.buffer.read(262145)
    assert len(raw) <= 262144
    completion = json.loads(raw)
    if not isinstance(completion, dict) or set(completion) != {'branch', 'environmentId', 'title', 'commitMessage', 'body'}:
        sys.exit('Missing container-use result metadata')
    if not isinstance(completion['branch'], str) or not isinstance(completion['environmentId'], str):
        sys.exit('Invalid container-use result metadata')
    publication_text(completion['title'])
    publication_text(completion['commitMessage'], True)
    publication_body(completion['body'])
    # Enumerate trusted ref names, then compare the ID as data, never as a Git revision.
    # No branch predicate: the name never participates in a Git command or path.
    refs = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)',
               'refs/remotes/container-use/').decode().splitlines()
    selected = [line.split(' ', 1)[1] for line in refs
                if line.split(' ', 1)[0] == 'refs/remotes/container-use/' + completion['environmentId']]
    if len(selected) != 1:
        sys.exit('Missing or unknown container-use result environment')
    result = commit_id(selected[0])
    assert git(repo, 'cat-file', '-t', result).strip() == b'commit'
    assert git(repo, 'rev-parse', source + '^{commit}').decode().strip() == source
    if git(repo, 'rev-parse', source + '^{tree}') == git(repo, 'rev-parse', result + '^{tree}'):
        print(json.dumps({'empty': True, 'sourceSha': source}))
        return
    git(repo, 'merge-base', '--is-ancestor', source, result)
    root = Path('result')
    if root.is_symlink():
        raise ValueError('Result directory must not be a symlink')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    bundle = root / 'result.bundle'
    # A fixed advertised head avoids exposing container-use refs or the agent name.
    git(repo, 'update-ref', 'refs/workflowd/result', result)
    git(repo, 'bundle', 'create', str(bundle.absolute()), 'refs/workflowd/result', '^' + source)
    assert bundle.stat().st_size <= 16 * 1024 * 1024
    manifest = {'sourceSha': source, 'resultSha': result, 'branch': completion['branch'],
                'bundleSha256': sha(bundle.read_bytes()),
                'treeSha': git(repo, 'rev-parse', result + '^{tree}').decode().strip(),
                'title': completion['title'], 'commitMessage': completion['commitMessage'], 'body': completion['body']}
    encoded = json.dumps(manifest, ensure_ascii=True, separators=(',', ':')).encode()
    assert len(encoded) <= 262144
    with (root / 'result.json').open('wb') as manifest_file:
        manifest_file.write(encoded)
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


def validate(source_url):
    binding = json.loads(sys.stdin.buffer.read(65537))
    source = commit_id(binding['source'])
    result = commit_id(binding['result'])
    path = Path('result.zip')
    if path.is_symlink():
        raise ValueError('Archive must not be a symlink')
    assert path.stat().st_size <= 16 * 1024 * 1024
    assert 'sha256:' + sha(path.read_bytes()) == binding['digest']
    root = Path('validated')
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
            assert entry.file_size <= (262144 if entry.filename == 'result.json' else 64 * 1024 * 1024)
            data = zipped.read(entry)
            assert len(data) == entry.file_size
            destination = root / ('result.json' if entry.filename == 'result.json' else 'result.bundle')
            destination.write_bytes(data)
    raw = (root / 'result.json').read_bytes()
    assert sha(raw) == binding['manifest']
    manifest = json.loads(raw)
    assert set(manifest) == {'sourceSha', 'resultSha', 'treeSha', 'branch', 'bundleSha256', 'title', 'commitMessage', 'body'}
    assert isinstance(manifest['branch'], str)
    publication_text(manifest['title'])
    publication_text(manifest['commitMessage'], True)
    publication_body(manifest['body'])
    assert manifest['treeSha'] == commit_id(binding['tree'])
    assert manifest['sourceSha'] == source and manifest['resultSha'] == result
    bundle = root.absolute() / 'result.bundle'
    assert sha(bundle.read_bytes()) == manifest['bundleSha256']
    repo = str(root.absolute() / 'objects.git')
    git(str(root), 'init', '--bare', repo)
    git(repo, '-c', 'credential.helper=', '-c', 'http.extraHeader=', 'fetch', '--no-tags', '--', source_url, source)
    before = set(git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').splitlines())
    heads = git(repo, 'bundle', 'list-heads', str(bundle)).decode().splitlines()
    assert heads == [result + ' refs/workflowd/result']
    git(repo, 'bundle', 'verify', str(bundle))
    git(repo, 'fetch', '--no-tags', '--', str(bundle), 'refs/workflowd/result')
    inventory = git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objectsize)').splitlines()
    added = [line.split() for line in inventory if line.split()[0] not in before]
    assert len(added) <= 10000 and sum(int(fields[1]) for fields in added) <= 64 * 1024**2
    git(repo, 'fsck', '--strict', '--no-reflogs', result)
    inspect_changes(repo, source, result)
    assert git(repo, 'rev-parse', result + '^{tree}').decode().strip() == manifest['treeSha']
    print(json.dumps(manifest, ensure_ascii=True, separators=(',', ':')))


def tree(source, result):
    source, result = commit_id(source), commit_id(result)
    repo = 'validated/objects.git'
    entries = git(repo, 'diff-tree', '-r', '--raw', '--no-renames', '-z', source, result).split(b'\0')[:-1]
    assert len(entries) % 2 == 0 and len(entries) <= 200
    changes = []
    for i in range(0, len(entries), 2):
        _, mode, _, blob, _ = entries[i].decode('ascii').split()
        path = entries[i + 1]
        safe_path(path)
        deleted = mode == '000000'
        item = {'path': path.decode('utf8'), 'mode': '100644' if deleted else mode,
                'type': 'blob', 'sha': None if deleted else blob}
        if not deleted:
            item['content'] = base64.b64encode(git(repo, 'cat-file', 'blob', blob)).decode('ascii')
        changes.append(item)
    print(json.dumps({'base_tree': git(repo, 'rev-parse', source + '^{tree}').decode().strip(),
                      'tree': changes}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        signal.alarm(180)
        if sys.argv[1] == 'seal': seal(*sys.argv[2:])
        elif sys.argv[1] == 'validate': validate(*sys.argv[2:])
        elif sys.argv[1] == 'tree': tree(*sys.argv[2:])
        else: raise ValueError('Unknown operation')
    except Exception:
        sys.exit('Sandbox result sealing failed')
