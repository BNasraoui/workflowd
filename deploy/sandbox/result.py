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
import urllib.parse
import tarfile

if sys.flags.optimize:
    raise RuntimeError('Python optimization is not supported')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def commit_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{40}', value):
        raise ValueError('Invalid commit identity')
    return value


def git(repo, *args, input=None, identity=None):
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
                 'GIT_ALLOW_PROTOCOL': 'https:file', **(identity or {})},
            input=input, stdout=output, stderr=subprocess.DEVNULL, timeout=60,
            check=True, preexec_fn=bounds)
        if output.tell() > 16 * 1024**2:
            raise ValueError('Git inventory exceeded bound')
        output.seek(0)
        return output.read()


# The corpus pins the policy to Unicode 15.0; never silently use another UCD.
UNICODE = json.loads(Path(__file__).with_name('publication-unicode.json').read_text())
if UNICODE['version'] != '15.0.0' or unicodedata.unidata_version != UNICODE['version']:
    raise RuntimeError('Unsupported publication Unicode runtime')
CASEFOLD = json.loads(Path(__file__).with_name('casefold.json').read_text())
INVISIBLE = re.compile('[' + UNICODE['forbidden'] + ']')
# Default_Ignorable_Code_Point, written once from DerivedCoreProperties.txt of Unicode
# 15.0.0 (Python has no table of this property). A test of the daemon compares each
# range with the regular expression class \p{Default_Ignorable_Code_Point} of Bun.
DEFAULT_IGNORABLE = (
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160),
    (0x17B4, 0x17B5), (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E),
    (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)
IGNORABLE = re.compile('[' + ''.join(f'{chr(a)}-{chr(b)}' for a, b in DEFAULT_IGNORABLE) + ']')


def invisible(c):
    """A code point that a reader cannot see: a format character (Cf) or a default-ignorable code point."""
    return unicodedata.category(c) == 'Cf' or IGNORABLE.match(c) is not None


# The Emoji property, written from emoji-data.txt of Unicode 17.0.0, the data of the
# daemon's engine (Python has no table of this property, and its other Unicode data here is
# 15.0.0). A test of the daemon compares each range with the class \p{Emoji} of Bun.
EMOJI = (
    (0x0023, 0x0023), (0x002A, 0x002A), (0x0030, 0x0039), (0x00A9, 0x00A9), (0x00AE, 0x00AE),
    (0x203C, 0x203C), (0x2049, 0x2049), (0x2122, 0x2122), (0x2139, 0x2139), (0x2194, 0x2199),
    (0x21A9, 0x21AA), (0x231A, 0x231B), (0x2328, 0x2328), (0x23CF, 0x23CF), (0x23E9, 0x23F3),
    (0x23F8, 0x23FA), (0x24C2, 0x24C2), (0x25AA, 0x25AB), (0x25B6, 0x25B6), (0x25C0, 0x25C0),
    (0x25FB, 0x25FE), (0x2600, 0x2604), (0x260E, 0x260E), (0x2611, 0x2611), (0x2614, 0x2615),
    (0x2618, 0x2618), (0x261D, 0x261D), (0x2620, 0x2620), (0x2622, 0x2623), (0x2626, 0x2626),
    (0x262A, 0x262A), (0x262E, 0x262F), (0x2638, 0x263A), (0x2640, 0x2640), (0x2642, 0x2642),
    (0x2648, 0x2653), (0x265F, 0x2660), (0x2663, 0x2663), (0x2665, 0x2666), (0x2668, 0x2668),
    (0x267B, 0x267B), (0x267E, 0x267F), (0x2692, 0x2697), (0x2699, 0x2699), (0x269B, 0x269C),
    (0x26A0, 0x26A1), (0x26A7, 0x26A7), (0x26AA, 0x26AB), (0x26B0, 0x26B1), (0x26BD, 0x26BE),
    (0x26C4, 0x26C5), (0x26C8, 0x26C8), (0x26CE, 0x26CF), (0x26D1, 0x26D1), (0x26D3, 0x26D4),
    (0x26E9, 0x26EA), (0x26F0, 0x26F5), (0x26F7, 0x26FA), (0x26FD, 0x26FD), (0x2702, 0x2702),
    (0x2705, 0x2705), (0x2708, 0x270D), (0x270F, 0x270F), (0x2712, 0x2712), (0x2714, 0x2714),
    (0x2716, 0x2716), (0x271D, 0x271D), (0x2721, 0x2721), (0x2728, 0x2728), (0x2733, 0x2734),
    (0x2744, 0x2744), (0x2747, 0x2747), (0x274C, 0x274C), (0x274E, 0x274E), (0x2753, 0x2755),
    (0x2757, 0x2757), (0x2763, 0x2764), (0x2795, 0x2797), (0x27A1, 0x27A1), (0x27B0, 0x27B0),
    (0x27BF, 0x27BF), (0x2934, 0x2935), (0x2B05, 0x2B07), (0x2B1B, 0x2B1C), (0x2B50, 0x2B50),
    (0x2B55, 0x2B55), (0x3030, 0x3030), (0x303D, 0x303D), (0x3297, 0x3297), (0x3299, 0x3299),
    (0x1F004, 0x1F004), (0x1F0CF, 0x1F0CF), (0x1F170, 0x1F171), (0x1F17E, 0x1F17F),
    (0x1F18E, 0x1F18E), (0x1F191, 0x1F19A), (0x1F1E6, 0x1F1FF), (0x1F201, 0x1F202),
    (0x1F21A, 0x1F21A), (0x1F22F, 0x1F22F), (0x1F232, 0x1F23A), (0x1F250, 0x1F251),
    (0x1F300, 0x1F321), (0x1F324, 0x1F393), (0x1F396, 0x1F397), (0x1F399, 0x1F39B),
    (0x1F39E, 0x1F3F0), (0x1F3F3, 0x1F3F5), (0x1F3F7, 0x1F4FD), (0x1F4FF, 0x1F53D),
    (0x1F549, 0x1F54E), (0x1F550, 0x1F567), (0x1F56F, 0x1F570), (0x1F573, 0x1F57A),
    (0x1F587, 0x1F587), (0x1F58A, 0x1F58D), (0x1F590, 0x1F590), (0x1F595, 0x1F596),
    (0x1F5A4, 0x1F5A5), (0x1F5A8, 0x1F5A8), (0x1F5B1, 0x1F5B2), (0x1F5BC, 0x1F5BC),
    (0x1F5C2, 0x1F5C4), (0x1F5D1, 0x1F5D3), (0x1F5DC, 0x1F5DE), (0x1F5E1, 0x1F5E1),
    (0x1F5E3, 0x1F5E3), (0x1F5E8, 0x1F5E8), (0x1F5EF, 0x1F5EF), (0x1F5F3, 0x1F5F3),
    (0x1F5FA, 0x1F64F), (0x1F680, 0x1F6C5), (0x1F6CB, 0x1F6D2), (0x1F6D5, 0x1F6D8),
    (0x1F6DC, 0x1F6E5), (0x1F6E9, 0x1F6E9), (0x1F6EB, 0x1F6EC), (0x1F6F0, 0x1F6F0),
    (0x1F6F3, 0x1F6FC), (0x1F7E0, 0x1F7EB), (0x1F7F0, 0x1F7F0), (0x1F90C, 0x1F93A),
    (0x1F93C, 0x1F945), (0x1F947, 0x1F9FF), (0x1FA70, 0x1FA7C), (0x1FA80, 0x1FA8A),
    (0x1FA8E, 0x1FAC6), (0x1FAC8, 0x1FAC8), (0x1FACD, 0x1FADC), (0x1FADF, 0x1FAEA),
    (0x1FAEF, 0x1FAF8),
)
# U+FE0F where it selects the emoji form: directly after a code point of EMOJI that is not
# ASCII (so not after a digit, '#' or '*').
EMOJI_PRESENTATION = re.compile('(?<=[' + ''.join(
    f'{chr(max(a, 0x80))}-{chr(b)}' for a, b in EMOJI if b >= 0x80) + '])\ufe0f')


def without_presentation(value):
    """The text with each U+FE0F that selects the emoji form left out: a commit message or a
    final message may hold one there and nowhere else. A path holds no U+FE0F."""
    return EMOJI_PRESENTATION.sub('', value)


LETTERS = re.compile('[' + UNICODE['letters'] + ']')
STACKED_MARKS = re.compile('[' + UNICODE['marks'] + ']{3}')
LANGUAGES = {'', 'text', 'diff', 'ts', 'typescript', 'tsx', 'js', 'json', 'sh', 'bash', 'python', 'rust', 'go', 'sql', 'yaml', 'toml'}
KEYWORD = r'(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)'
CLOSING = re.compile(r'(?=' + KEYWORD + r'(?:#[0-9]|gh-[0-9]|[a-z0-9_.-]+/[a-z0-9_.-]+#|https?://))')
GITHUB_CLOSING = re.compile(r'(?=(' + KEYWORD + r'github\.com/))')
WHITESPACE = re.compile(r'\s')
GITHUB_PATH = re.compile(r'/(?:issues|pull)/')


def keyword_starts(pattern, text):
    # Each match of `pattern` whose keyword does not follow a letter.
    return (m for m in pattern.finditer(text) if m.start() == 0 or not LETTERS.fullmatch(text[m.start() - 1]))


def closes_github_path(text):
    # A closing keyword names a github.com path that holds /issues/ or /pull/ before the next
    # white space. One pass: a later keyword reuses the searches of the one before it.
    space = path = -1
    for m in keyword_starts(GITHUB_CLOSING, text):
        end = m.end(1)
        if space < end:
            found = WHITESPACE.search(text, end)
            space = found.start() if found else len(text)
        if path < end:
            found = GITHUB_PATH.search(text, end)
            path = found.start() if found else len(text)
        if path < space:
            return True
    return False


def safe_publication(value):
    if INVISIBLE.search(value):
        raise ValueError('Invisible publication content')
    if any((unicodedata.category(c) == 'Cc' and c != '\n') or invisible(c) for c in value):
        raise ValueError('Invalid publication text')
    if re.search(r'&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);', value):
        raise ValueError('Character reference')
    if STACKED_MARKS.search(unicodedata.normalize('NFD', value)):
        raise ValueError('Stacked combining marks')
    normalized = ''.join(CASEFOLD.get(c, c) for c in unicodedata.normalize('NFKC', value))
    for separator in ('', ' '):
        folded = re.sub(r'[*_~`\[\]()]', separator, normalized)
        if any(keyword_starts(CLOSING, folded)) or closes_github_path(folded):
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
            if re.match(r'^ {0,3}(?:>|(?:[-+*]|[0-9]+[.)]) ).*(?:`{3}|~{3})', line):
                raise ValueError('Nested fence')
            opener = re.fullmatch(r'(`{3,}|~{3,})(.*)', line)
            if opener:
                if not blank or opener[2] not in LANGUAGES:
                    raise ValueError('Invalid fence opening')
                fence = opener[1]
            elif re.search(r'[<@$\\]', line) or '\\' in unicodedata.normalize('NFKC', line):
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
    if any((unicodedata.category(c) == 'Cc' and not (message and c == '\n')) or invisible(c) for c in value):
        raise ValueError('Invalid publication text')
    if not message and any(c in value for c in ('\u2028', '\u2029')):
        raise ValueError('Invalid publication text')
    if message and (re.search(r'[<@$\\]', value) or '\\' in unicodedata.normalize('NFKC', value)):
        raise ValueError('HTML, mention, math or backslash in commit message')
    safe_publication(value)


def commit_message(value):
    """The rules of a run's commit message: U+FE0F only where it selects the emoji form, then
    the publication rules of a commit message, as the daemon's check holds them."""
    if not isinstance(value, str):
        raise ValueError('Invalid publication text')
    publication_text(without_presentation(value), True)


def publication_body(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('body must be non-empty Markdown')
    if len(value.encode('utf8', errors='strict')) > 32768:
        raise ValueError('body exceeds 32 KiB UTF-8')
    safe_publication(value)


def final_message(value):
    # Data to the caller: newlines and tabs, and no other control or invisible character.
    if not isinstance(value, str) or len(value.encode('utf8', errors='strict')) > 65536 or any(
            (unicodedata.category(c) == 'Cc' and c not in '\n\t') or invisible(c)
            for c in without_presentation(value)):
        raise ValueError('Invalid final message')


def seal(source):
    # The control entrypoint selects the workspace; no caller-supplied paths.
    repo = 'repository'
    source = commit_id(source)
    raw = sys.stdin.buffer.read(262145)
    if len(raw) > 262144:
        raise ValueError('Seal input exceeded bound')
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
    if git(repo, 'cat-file', '-t', result).strip() != b'commit':
        raise ValueError('Result must be a commit')
    if git(repo, 'rev-parse', source + '^{commit}').decode().strip() != source:
        raise ValueError('Source commit mismatch')
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
    if bundle.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Bundle exceeded bound')
    manifest = {'sourceSha': source, 'resultSha': result, 'branch': completion['branch'],
                'bundleSha256': sha(bundle.read_bytes()),
                'treeSha': git(repo, 'rev-parse', result + '^{tree}').decode().strip(),
                'title': completion['title'], 'commitMessage': completion['commitMessage'], 'body': completion['body']}
    encoded = json.dumps(manifest, ensure_ascii=True, separators=(',', ':')).encode()
    if len(encoded) > 262144:
        raise ValueError('Manifest exceeded bound')
    with (root / 'result.json').open('wb') as manifest_file:
        manifest_file.write(encoded)
    print(json.dumps({**manifest, 'manifestSha256': sha(encoded)}, separators=(',', ':')))


# Characters that change what a reviewer of a pushed path sees: each invisible code
# point (the bidi controls, the joiners, the variation selectors and the tags among
# them) and the line and paragraph separators (as the daemon's check).
PATH_MARKS = re.compile('[\u2028\u2029]')


def safe_path(raw):
    name = raw.decode('utf8', errors='strict')
    parts = name.split('/')
    if any(p in ('', '.', '..') or p.lower().startswith('.git') for p in parts):
        raise ValueError('Unsafe path component')
    if name.startswith('deploy/sandbox/') or name == 'deploy/sandbox':
        raise ValueError('Sandbox tooling path is forbidden')
    if '\\' in name or PATH_MARKS.search(name) or any(unicodedata.category(c) == 'Cc' or invisible(c) for c in name):
        raise ValueError('Invalid path characters')
    if unicodedata.normalize('NFC', name) != name:
        raise ValueError('Path must be NFC normalized')
    return name.casefold()


def content_check(data, sensitive):
    # Defined encodings only; this is not general DLP. Scan complete bounded values,
    # including whitespace-fragmented forms, rather than independent output lines.
    compact = re.sub(rb'\s+', b'', data)
    if re.search(rb'(?:gh[pousr]_|github_pat_|sk-ant-)[A-Za-z0-9_-]{16,}|-----BEGIN(?:RSA|EC|OPENSSH)?PRIVATEKEY-----', compact):
        raise ValueError('Credential-shaped public content')
    for value in sensitive:
        raw = value.encode('utf8')
        forms = [raw, base64.b64encode(raw), base64.urlsafe_b64encode(raw).rstrip(b'='),
                 raw.hex().encode(), raw.hex().upper().encode(), urllib.parse.quote(value, safe='').encode()]
        if any(re.sub(rb'\s+', b'', form) in compact for form in forms):
            raise ValueError('Sensitive public content')


def agent_identity(identity):
    if not isinstance(identity, dict) or set(identity) != {'name', 'email'}:
        raise ValueError('Invalid identity')
    name, email = identity['name'], identity['email']
    if not isinstance(name, str) or not name.strip() or re.search(r'[\r\n\0<>]', name) or len(name) > 200 or any(
            invisible(c) for c in name):
        raise ValueError('Invalid identity')
    if not isinstance(email, str) or not re.fullmatch(r'[^\s<>@\0]+@[^\s<>@\0]+', email) or len(email) > 200:
        raise ValueError('Invalid identity')
    return {'GIT_AUTHOR_NAME': name, 'GIT_COMMITTER_NAME': name,
            'GIT_AUTHOR_EMAIL': email, 'GIT_COMMITTER_EMAIL': email,
            'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}


def native_seal(source):
    """Called only after the supervisor stops the container and exports its fixed workspace.

    source.git is controller-created and never mounted in the agent. repository is
    an owned, offline export, not a live agent mount. No agent Git command is run.
    The run names no branch: the daemon chooses the target ref after its own checks.
    """
    source = commit_id(source)
    raw = sys.stdin.buffer.read(262145)
    if len(raw) > 262144: raise ValueError('Native input exceeded bound')
    request = json.loads(raw)
    if set(request) != {'completion', 'sensitiveValues', 'identity'}: raise ValueError('Invalid native request')
    completion, sensitive = request['completion'], request['sensitiveValues']
    # The daemon gives the identity of agent runs; its check requires each commit to carry it.
    author = agent_identity(request['identity'])
    if not isinstance(completion, dict) or set(completion) != {'title', 'commitMessage', 'body', 'finalMessage'}:
        raise ValueError('Invalid native metadata')
    if not isinstance(sensitive, list) or len(sensitive) > 32 or any(not isinstance(v, str) or not 16 <= len(v) <= 4096 for v in sensitive):
        raise ValueError('Invalid sensitive values')
    publication_text(completion['title'])
    commit_message(completion['commitMessage'])
    publication_body(completion['body'])
    final_message(completion['finalMessage'])
    content_check(json.dumps(completion, ensure_ascii=False).encode(), sensitive)
    if Path('repository').is_symlink() or Path('source.git').is_symlink(): raise ValueError('Unsafe source path')
    with tempfile.TemporaryDirectory(prefix='native-capture-', dir='.') as directory:
        repo = str(Path(directory).absolute())
        git(repo, 'init', '--bare', '.')
        git(repo, 'fetch', '--no-tags', '--', str(Path('source.git').absolute()), source)
        git(repo, 'read-tree', source)
        selected = git(repo, '--work-tree=' + str(Path('repository').absolute()),
                       'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')
        git(repo, 'read-tree', '--empty')
        index, total, count = [], 0, 0
        for relative in sorted(set(selected) - {b''}):
            content_check(relative, sensitive)
            parts = relative.decode('utf8').split('/')
            if any(part in ['', '.', '..', '.git'] for part in parts): raise ValueError('Unsafe native path')
            path = Path('repository', *parts)
            if any(parent.is_symlink() for parent in path.parents): raise ValueError('Linked directory')
            try: info = path.lstat()
            except FileNotFoundError: continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024**2:
                raise ValueError('Unsafe native file')
            total += info.st_size
            count += 1
            if count > 10000 or total > 64 * 1024**2: raise ValueError('Native workspace exceeded bound')
            data = path.read_bytes()
            content_check(data, sensitive)
            blob = git(repo, 'hash-object', '-w', '--no-filters', '--stdin', input=data).strip()
            mode = b'100755' if info.st_mode & 0o111 else b'100644'
            index.append(mode + b' blob ' + blob + b'\t' + relative + b'\0')
        git(repo, 'update-index', '-z', '--index-info', input=b''.join(index))
        tree = git(repo, 'write-tree').decode().strip()
        if tree == git(repo, 'rev-parse', source + '^{tree}').decode().strip():
            print(json.dumps({'empty': True, 'sourceSha': source}))
            return
        # The message is stdin data, never an argument.
        result = git(repo, 'commit-tree', tree, '-p', source,
                     input=completion['commitMessage'].encode('utf8'), identity=author).decode().strip()
        inspect_changes(repo, source, result, sensitive)
        # Only validated, source-relative objects become an intended-public artifact.
        root = Path('result')
        root.mkdir(mode=0o700)
        bundle = root / 'result.bundle'
        git(repo, 'update-ref', 'refs/workflowd/result', result)
        git(repo, 'bundle', 'create', str(bundle.absolute()), 'refs/workflowd/result', '^' + source)
        if bundle.stat().st_size > 16 * 1024**2: raise ValueError('Bundle exceeded bound')
        # result.json holds exactly the SealedResult keys; the daemon refuses any other.
        # The commit message is in the commit object only.
        manifest = {'sourceSha': source, 'title': completion['title'], 'body': completion['body'],
                    'finalMessage': completion['finalMessage']}
        encoded = json.dumps(manifest, ensure_ascii=True, separators=(',', ':')).encode()
        (root / 'result.json').write_bytes(encoded)
        print(json.dumps({'sourceSha': source, 'resultSha': result, 'bundleSha256': sha(bundle.read_bytes()),
                          'manifestSha256': sha(encoded)}, separators=(',', ':')))


def native_export(archive, source=None):
    # Never ask Docker/tar to extract agent-owned paths on the runner host.
    # Even .git is discarded rather than loaded as a repository configuration.
    if Path(archive).stat().st_size > 96 * 1024**2: raise ValueError('Native export capacity')
    root = Path('repository')
    root.mkdir(mode=0o700)
    if source is not None: source = commit_id(source)
    count, total, seen, links = 0, 0, set(), set()
    with tarfile.open(archive, 'r:') as stream:
        for item in stream:
            if item.size < 0: raise ValueError('Invalid export size')
            name = item.name.removeprefix('./').rstrip('/')
            if name in ['', '.']: continue
            parts = name.split('/')
            if name.startswith('/') or any(p in ['', '.', '..'] for p in parts): raise ValueError('Unsafe export path')
            if parts[0] == '.git': continue
            count += 1
            total += item.size
            if count > 10000 or total > 64 * 1024**2 or item.size > 1024**2: raise ValueError('Native export capacity')
            if name in seen: raise ValueError('Duplicate export path')
            seen.add(name)
            path = root.joinpath(*parts)
            if item.isdir(): path.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif item.isfile():
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with path.open('xb') as output, stream.extractfile(item) as data:
                    output.write(data.read(1024**2 + 1))
                path.chmod(0o700 if item.mode & 0o111 else 0o600)
            elif item.issym() and source is not None:
                # A regular empty placeholder lets Git apply ignore rules without
                # ever creating/following an agent link or reading its destination.
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                path.touch(mode=0o600, exist_ok=False)
                links.add(name.encode('utf8'))
            else: raise ValueError('Unsafe export entry')
    if links:
        if Path('source.git').is_symlink(): raise ValueError('Unsafe source path')
        with tempfile.TemporaryDirectory(prefix='native-selection-', dir='.') as directory:
            repo = str(Path(directory).absolute())
            git(repo, 'init', '--bare', '.')
            git(repo, 'fetch', '--no-tags', '--', str(Path('source.git').absolute()), source)
            git(repo, 'read-tree', source)
            selected = set(git(repo, '--work-tree=' + str(root.absolute()),
                               'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0'))
            if links & selected: raise ValueError('Selected export link')
        for name in links: root.joinpath(name.decode('utf8')).unlink()


def inspect_changes(repo, source, result, sensitive=()):
    commits = git(repo, 'rev-list', '--reverse', source + '..' + result).decode().splitlines()
    if not (1 <= len(commits) <= 100):
        raise ValueError('Commit count exceeded bound')
    objects = git(repo, 'rev-list', '--objects', source + '..' + result).splitlines()
    if len(objects) > 10000:
        raise ValueError('Object count exceeded bound')
    total = 0
    for obj in objects:
        total += int(git(repo, 'cat-file', '-s', obj.split(b' ')[0].decode()))
        if total > 64 * 1024 * 1024:
            raise ValueError('Object bytes exceeded bound')
        content_check(git(repo, 'cat-file', '-p', obj.split(b' ')[0].decode()), sensitive)
    parent = source
    content = 0
    changed = set()
    for commit in commits:
        if git(repo, 'rev-list', '--parents', '-n', '1', commit).decode().split() != [commit, parent]:
            raise ValueError('History must be linear')
        entries = git(repo, 'diff-tree', '-r', '--raw', '--no-renames', '-z', parent, commit).split(b'\0')
        if entries[-1] != b'':
            raise ValueError('Invalid diff terminator')
        entries.pop()
        if len(entries) % 2 != 0:
            raise ValueError('Invalid diff entries')
        for i in range(0, len(entries), 2):
            fields = entries[i].decode('ascii').split()
            if len(fields) != 5:
                raise ValueError('Invalid diff fields')
            old, new, _, blob, _ = fields
            old = old.removeprefix(':')
            path = entries[i + 1]
            content_check(path, sensitive)
            safe_path(path)
            changed.add(path)
            if len(changed) > 100:
                raise ValueError('Changed path count exceeded bound')
            if not (old in ('000000', '100644', '100755') and new in ('000000', '100644', '100755')):
                raise ValueError('Unsupported file mode')
            if not (new == '000000' or (new == '100644' if old == '000000' else old == new)):
                raise ValueError('Forbidden file mode change')
            if new != '000000':
                size = int(git(repo, 'cat-file', '-s', blob))
                if size > 1024 * 1024:
                    raise ValueError('Blob exceeded bound')
                content += size
                if content > 8 * 1024 * 1024:
                    raise ValueError('Content exceeded bound')
        # Detect case/normalization collisions against the complete tree, including base paths.
        names = git(repo, 'ls-tree', '-r', '-z', '--name-only', commit).split(b'\0')[:-1]
        folded = {}
        for name in names:
            key = unicodedata.normalize('NFC', name.decode('utf8')).casefold()
            if name in changed:
                if not (key not in folded or folded[key] == name):
                    raise ValueError('Path collision')
            if key in folded and folded[key] in changed:
                if folded[key] != name:
                    raise ValueError('Path collision')
            folded[key] = name
        parent = commit
    if parent != result:
        raise ValueError('Result history mismatch')


def validate(source_url):
    binding = json.loads(sys.stdin.buffer.read(65537))
    source = commit_id(binding['source'])
    result = commit_id(binding['result'])
    path = Path('result.zip')
    if path.is_symlink():
        raise ValueError('Archive must not be a symlink')
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Archive exceeded bound')
    if 'sha256:' + sha(path.read_bytes()) != binding['digest']:
        raise ValueError('Archive digest mismatch')
    root = Path('validated')
    root.mkdir(mode=0o700, parents=True)
    with zipfile.ZipFile(path) as zipped:
        entries = zipped.infolist()
        if not (len(entries) == 2 and {e.filename for e in entries} == {'result.json', 'result.bundle'}):
            raise ValueError('Invalid archive entries')
        if sum(e.file_size for e in entries) > 64 * 1024 * 1024:
            raise ValueError('Expanded archive exceeded bound')
        for entry in entries:
            mode = entry.external_attr >> 16
            if mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('Invalid archive mode')
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('Unsupported archive compression')
            if entry.flag_bits & 1:
                raise ValueError('Encrypted archive entry')
            if entry.file_size > (262144 if entry.filename == 'result.json' else 64 * 1024 * 1024):
                raise ValueError('Archive entry exceeded bound')
            data = zipped.read(entry)
            if len(data) != entry.file_size:
                raise ValueError('Archive entry size mismatch')
            destination = root / ('result.json' if entry.filename == 'result.json' else 'result.bundle')
            destination.write_bytes(data)
    raw = (root / 'result.json').read_bytes()
    if sha(raw) != binding['manifest']:
        raise ValueError('Manifest digest mismatch')
    manifest = json.loads(raw)
    if set(manifest) != {'sourceSha', 'resultSha', 'treeSha', 'branch', 'bundleSha256', 'title', 'commitMessage', 'body'}:
        raise ValueError('Invalid manifest fields')
    content_check(json.dumps(manifest, ensure_ascii=False).encode('utf8'), [])
    if not isinstance(manifest['branch'], str):
        raise ValueError('Invalid manifest branch')
    publication_text(manifest['title'])
    publication_text(manifest['commitMessage'], True)
    publication_body(manifest['body'])
    if manifest['treeSha'] != commit_id(binding['tree']):
        raise ValueError('Manifest tree mismatch')
    if not (manifest['sourceSha'] == source and manifest['resultSha'] == result):
        raise ValueError('Manifest commit mismatch')
    bundle = root.absolute() / 'result.bundle'
    if sha(bundle.read_bytes()) != manifest['bundleSha256']:
        raise ValueError('Bundle digest mismatch')
    repo = str(root.absolute() / 'objects.git')
    git(str(root), 'init', '--bare', repo)
    git(repo, '-c', 'credential.helper=', '-c', 'http.extraHeader=', 'fetch', '--no-tags', '--', source_url, source)
    before = set(git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').splitlines())
    heads = git(repo, 'bundle', 'list-heads', str(bundle)).decode().splitlines()
    if heads != [result + ' refs/workflowd/result']:
        raise ValueError('Bundle heads mismatch')
    git(repo, 'bundle', 'verify', str(bundle))
    git(repo, 'fetch', '--no-tags', '--', str(bundle), 'refs/workflowd/result')
    inventory = git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objectsize)').splitlines()
    added = [line.split() for line in inventory if line.split()[0] not in before]
    if not (len(added) <= 10000 and sum(int(fields[1]) for fields in added) <= 64 * 1024**2):
        raise ValueError('Imported objects exceeded bound')
    git(repo, 'fsck', '--strict', '--no-reflogs', result)
    inspect_changes(repo, source, result)
    if git(repo, 'rev-parse', result + '^{tree}').decode().strip() != manifest['treeSha']:
        raise ValueError('Result tree mismatch')
    print(json.dumps(manifest, ensure_ascii=True, separators=(',', ':')))


def tree(source, result):
    source, result = commit_id(source), commit_id(result)
    repo = 'validated/objects.git'
    entries = git(repo, 'diff-tree', '-r', '--raw', '--no-renames', '-z', source, result).split(b'\0')[:-1]
    if not (len(entries) % 2 == 0 and len(entries) <= 200):
        raise ValueError('Invalid tree changes')
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
        elif sys.argv[1] == 'native-seal': native_seal(*sys.argv[2:])
        elif sys.argv[1] == 'native-export': native_export(*sys.argv[2:])
        elif sys.argv[1] == 'validate': validate(*sys.argv[2:])
        elif sys.argv[1] == 'tree': tree(*sys.argv[2:])
        else: raise ValueError('Unknown operation')
    except ValueError as error:
        # Only the fixed reasons of this script are printed: a reason of Python itself
        # (lower case, quoted) or of a ValueError subclass may hold input text.
        reason = error.args[0] if type(error) is ValueError and len(error.args) == 1 else ''
        fixed = isinstance(reason, str) and re.fullmatch(r'[A-Z][A-Za-z0-9 ,./-]{0,80}', reason)
        sys.exit('Sandbox result sealing failed' + (': ' + reason if fixed else ''))
    except Exception:
        sys.exit('Sandbox result sealing failed')
