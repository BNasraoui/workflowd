#!/usr/bin/env python3
"""Private runner-host PTY custodian. Production owns docker exec from outside
the UID1000 agent container. PTY bytes and agent-writable hook/transcript files are
untrusted data; only controller commands and owned exec exit determine closure.
"""
import fcntl
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import contextmanager
import json
import os
from pathlib import Path
import pty
import select
import re
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import threading
import uuid
from urllib.parse import urlsplit

DIGEST = 'bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222'
NATIVE_ENV = {'PATH','HOME','LANG','TERM','TMPDIR','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL',
    'WORKFLOWD_GATEWAY_URL','WORKFLOWD_GATEWAY_SENTINEL','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_AUTOUPDATER','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_TERMINAL_PROMPT','GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_AUTHOR_NAME','GIT_COMMITTER_NAME','GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_EMAIL','NIX_LD','NIX_LD_LIBRARY_PATH'}


def emit(event, **fields):
    print(json.dumps({'event': event, **fields}, separators=(',', ':')), flush=True)


def hook():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536: raise ValueError('Hook capacity')
    event = json.loads(raw)
    session = str(uuid.UUID(event['session_id']))
    if event['hook_event_name'] == 'SessionStart':
        (Path(os.environ['HOME']) / 'native-transcript.json').write_text(json.dumps({'session': session, 'path': event['transcript_path']}))
        return
    if event['hook_event_name'] != 'Stop': raise ValueError('Unexpected hook')
    with (Path(os.environ['HOME']) / 'stops.jsonl').open('a') as output:
        output.write(json.dumps({'event': 'Stop', 'session': session}) + '\n')


def submit():
    raw = sys.argv[2].encode('utf8') if len(sys.argv) == 3 else sys.stdin.buffer.read(65537)
    if len(raw) > 65536: raise ValueError('Result capacity')
    json.loads(raw)
    url = urlsplit(os.environ['WORKFLOWD_GATEWAY_URL'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path or url.query or url.fragment or url.username:
        raise ValueError('Loopback result gateway required')
    connection = http.client.HTTPConnection('127.0.0.1', url.port, timeout=10)
    try:
        connection.request('POST', '/capabilities/v1/result', raw, {
            'Authorization': 'Bearer ' + os.environ['WORKFLOWD_GATEWAY_SENTINEL'],
            'Content-Type': 'application/json',
        })
        response = connection.getresponse()
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096: raise ValueError('Result not accepted')
        receipt = json.loads(body)
        if set(receipt) != {'revision'} or type(receipt['revision']) is not int or not 1 <= receipt['revision'] <= 100:
            raise ValueError('Result receipt refused')
        print(json.dumps(receipt), flush=True)
    finally: connection.close()


def configuration():
    raw = sys.stdin.buffer.readline(1048577)
    if len(raw) > 1048576 or not raw.endswith(b'\n'): raise ValueError('Launch capacity')
    value = json.loads(raw)
    if set(value) - {'container'} != {'binary', 'home', 'workspace', 'session', 'model', 'effort', 'prompt', 'resume', 'baseUrl', 'sentinel', 'deadline', 'tools', 'allowedTools'}:
        raise ValueError('Invalid launch')
    for key in ['binary', 'home', 'workspace']:
        if not isinstance(value[key], str) or not Path(value[key]).is_absolute(): raise ValueError('Invalid path')
    if str(uuid.UUID(value['session'])) != value['session']: raise ValueError('Invalid session')
    if type(value['resume']) is not bool or not isinstance(value['prompt'], str) or not value['prompt']:
        raise ValueError('Invalid turn')
    if not isinstance(value['model'], str) or not value['model'] or value['model'].startswith('-'):
        raise ValueError('Invalid model')
    if value['effort'] not in ['low', 'medium', 'high', 'max']: raise ValueError('Invalid effort')
    if not isinstance(value['sentinel'], str) or not 8 <= len(value['sentinel']) <= 256: raise ValueError('Invalid sentinel')
    if isinstance(value['baseUrl'], dict):
        if set(value['baseUrl']) != {'socket'} or not Path(value['baseUrl']['socket']).is_absolute():
            raise ValueError('Job socket required')
    else:
        url = urlsplit(value['baseUrl'])
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path or url.query or url.fragment or url.username:
            raise ValueError('Loopback gateway required')
    if not time.time() < value['deadline'] <= time.time() + 285 * 60: raise ValueError('Invalid deadline')
    for key in ['tools', 'allowedTools']:
        if not isinstance(value[key], list) or len(value[key]) > 32 or any(not isinstance(v, str) or not v or len(v) > 256 or v.startswith('-') for v in value[key]):
            raise ValueError('Invalid tool policy')
    if 'container' in value:
        if not re.fullmatch('workflowd-native-[a-f0-9]{64}', value['container']): raise ValueError('Owned container required')
    else:
        with open(value['binary'], 'rb') as binary:
            if hashlib.file_digest(binary, 'sha256').hexdigest() != DIGEST: raise ValueError('Native pin mismatch')
    return value


def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


@contextmanager
def gateway(base_url, sentinel, port=0):
    if isinstance(base_url, str):
        yield base_url
        return
    active, lock, slots = set(), threading.Lock(), threading.BoundedSemaphore(4)

    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(120)
            self.sock.connect(base_url['socket'])

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def do_GET(self): self.proxy()
        def do_POST(self): self.proxy()

        def proxy(self):
            git = bool(re.fullmatch(r'/capabilities/v1/git/[1-9][0-9]{0,15}\.git/' +
                (r'info/refs\?service=git-upload-pack' if self.command == 'GET' else r'git-upload-pack'), self.path))
            length = self.headers.get('Content-Length', '0' if self.command == 'GET' else '')
            if (not (git or (self.command == 'POST' and re.fullmatch(r'/v1/messages(?:/count_tokens)?(?:\?beta=true)?|/capabilities/v1/result|/capabilities/v1/providers/[A-Za-z0-9_-]{1,128}/(?:responses|chat/completions)', self.path))) or
                self.headers.get_all('Authorization') != ['Bearer ' + sentinel] or
                (self.headers.get_all('Content-Length') is not None and self.headers.get_all('Content-Length') != [length]) or
                not length.isdecimal() or int(length) > 1048576 or
                (self.command == 'GET' and int(length) != 0) or
                (git and (self.headers.get_all('Host') != ['127.0.0.1:' + str(self.server.server_port)] or
                    any(k.lower() not in ['authorization', 'host', 'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language', 'pragma', 'user-agent', 'git-protocol', 'connection'] for k in self.headers) or
                    self.headers.get('Connection', 'close').lower() not in ['close', 'keep-alive'])) or
                self.headers.get('Transfer-Encoding') or self.headers.get('x-api-key') or
                sum(len(k) + len(v) for k, v in self.headers.items()) > 8192):
                self.send_error(403)
                return
            if not slots.acquire(blocking=False):
                self.send_error(429)
                return
            connection = UnixConnection('capability.invalid', timeout=120)
            try:
                self.connection.settimeout(10)
                body = self.rfile.read(int(length))
                if len(body) != int(length): raise ValueError('Truncated request')
                with lock: active.add(connection)
                headers = {key: value for key, value in self.headers.items() if key.lower() in
                           ['authorization', 'content-type', 'anthropic-version', 'anthropic-beta', 'x-claude-code-session-id', 'git-protocol']}
                connection.request(self.command, self.path, body, headers)
                response = connection.getresponse()
                self.send_response(response.status)
                for key in ['content-type', 'request-id', 'retry-after']:
                    value = response.getheader(key)
                    if value is not None: self.send_header(key, value)
                self.send_header('Connection', 'close')
                self.end_headers()
                count = 0
                while chunk := response.read1(65536):
                    count += len(chunk)
                    if count > 32 * 1048576: raise ValueError('Response capacity')
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except Exception:
                self.close_connection = True
            finally:
                with lock: active.discard(connection)
                connection.close()
                slots.release()

    server = ThreadingHTTPServer(('127.0.0.1', port), Proxy)
    worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
    worker.start()
    try: yield 'http://127.0.0.1:' + str(server.server_port)
    finally:
        server.shutdown()
        with lock:
            for connection in active:
                if connection.sock:
                    try: connection.sock.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                connection.close()
        server.server_close()
        worker.join(timeout=1)


def run():
    os.umask(0o077)
    value = configuration()
    with gateway(value['baseUrl'], value['sentinel']) as base_url:
        value['baseUrl'] = base_url
        invoke(value)


def prepare(home, workspace):
    if home.is_symlink() or workspace.is_symlink(): raise ValueError('Unsafe custody')
    home.mkdir(mode=0o700, exist_ok=True)
    config = home / '.claude.json'
    if config.is_symlink(): raise ValueError('Unsafe configuration')
    config.write_text(json.dumps({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'autoUpdates': False,
        'projects': {str(workspace): {'hasTrustDialogAccepted': True}},
    }))


def invoke(value):
    home, workspace = Path(value['home']), Path(value['workspace'])
    if 'container' not in value: prepare(home, workspace)
    env = {
        'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
        'TMPDIR': os.environ.get('TMPDIR', '/tmp'),
        'CLAUDE_CODE_OAUTH_TOKEN': value['sentinel'], 'ANTHROPIC_BASE_URL': value['baseUrl'],
        'WORKFLOWD_GATEWAY_URL': value['baseUrl'], 'WORKFLOWD_GATEWAY_SENTINEL': value['sentinel'],
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
        'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': '/dev/null',
        'GIT_AUTHOR_NAME': 'Workflowd Agent', 'GIT_COMMITTER_NAME': 'Workflowd Agent',
        'GIT_AUTHOR_EMAIL': 'agent@workflowd.invalid', 'GIT_COMMITTER_EMAIL': 'agent@workflowd.invalid',
        **{key: os.environ[key] for key in ['NIX_LD', 'NIX_LD_LIBRARY_PATH'] if key in os.environ},
    }
    # Executable/script paths are pinned by the host. Shell quoting here is only
    # for Claude's command-hook contract, never interpolated task/model content.
    import shlex
    hook_command = shlex.join(['/bin/python3', '/opt/workflowd/claude-interactive.py', 'hook'] if 'container' in value else [sys.executable, str(Path(__file__).resolve()), 'hook'])
    args = [value['binary'], '--model', value['model'], '--effort', value['effort'],
            '--permission-mode', 'dontAsk', '--tools', ','.join(value['tools']),
            '--allowedTools', *value['allowedTools'], '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--setting-sources', '', '--disable-slash-commands', '--no-chrome',
            '--settings', json.dumps({'attribution': {'commit': '', 'pr': ''}, 'hooks': {name: [{'hooks': [{'type': 'command', 'command': hook_command, 'timeout': 5}]}] for name in ['SessionStart', 'Stop']}}),
            '--resume' if value['resume'] else '--session-id', value['session'], '--', value['prompt']]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
    if 'container' in value:
        # The host owns both the PTY and exec client; agent output never shares
        # this custodian's control stdout. Agent HOME and PID namespace stay inside.
        prefix = ['/usr/bin/docker', 'exec', '--interactive', '--tty', '--user', '1000:1000', '--workdir', str(workspace)]
        for key, item in env.items(): prefix.extend(['--env', key + '=' + item])
        args = [*prefix, value['container'], '/bin/python3', '/opt/workflowd/claude-interactive.py', 'exec', *args[1:]]
    child = subprocess.Popen(args, cwd=None if 'container' in value else workspace,
        env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent'} if 'container' in value else env,
        stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
    os.close(slave)
    cancelled = False
    def cancel_signal(*_):
        nonlocal cancelled
        cancelled = True
    for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]: signal.signal(sig, cancel_signal)
    emit('started', session=value['session'])
    buffer, size, finishing = b'', 0, None
    outcome = 'operator_required'
    deadline = value['deadline']
    try:
        while child.poll() is None and time.time() < deadline and not cancelled:
            for descriptor in select.select([master, 0], [], [], 0.05)[0]:
                if descriptor == master:
                    try: data = os.read(master, 65536)
                    except OSError: data = b''
                    size += len(data)
                    if size > 1024**2: raise ValueError('PTY capacity')
                    sys.stderr.buffer.write(data)
                    sys.stderr.buffer.flush()
                else:
                    data = os.read(0, 4097)
                    if not data:
                        cancelled = True
                        break
                    buffer += data
                    if len(buffer) > 4096: raise ValueError('Control capacity')
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        command = json.loads(line)
                        if command == {'operation': 'cancel'}:
                            cancelled = True
                        elif command in [{'operation':'finish'},{'operation':'pause'}] and not finishing:
                            finishing = command['operation']
                            os.write(master, b'\x04\x04')
                            deadline = min(deadline, time.time() + 5)
                        else: raise ValueError('Control refused')
        if cancelled: outcome = 'cancelled'
        elif finishing and child.poll() == 0: outcome = 'paused' if finishing=='pause' else 'completed'
    finally:
        # The host subsequently stops the whole container, including processes
        # that escaped this process group. Never equate this group with a container.
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=1)
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.close(master)
    emit('closed', session=value['session'], outcome=outcome, exitCode=child.returncode)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['hook']: hook()
        elif sys.argv[1:] == ['prepare']:
            if os.getuid()!=1000 or os.getgid()!=1000: raise ValueError('Native UID refused')
            with open('/bin/claude','rb') as binary:
                if hashlib.file_digest(binary,'sha256').hexdigest()!=DIGEST: raise ValueError('Native pin mismatch')
            prepare(Path('/home/agent'),Path('/workdir'))
        elif sys.argv[1:] == ['serve']:
            with gateway({'socket':'/run/workflowd-gateway.sock'},'workflowd-local',31741):
                while True: signal.pause()
        elif len(sys.argv)>2 and sys.argv[1]=='exec':
            if os.getuid()!=1000 or os.getgid()!=1000: raise ValueError('Native UID refused')
            os.execve('/bin/claude',['/bin/claude',*sys.argv[2:]],{k:v for k,v in os.environ.items() if k in NATIVE_ENV})
        elif len(sys.argv) in [2, 3] and sys.argv[1] == 'submit': submit()
        elif len(sys.argv) == 1: run()
        else: raise ValueError('Unknown operation')
    except Exception:
        # Raw Python exceptions may contain task data or launch material.
        emit('failed')
        sys.exit(1)
