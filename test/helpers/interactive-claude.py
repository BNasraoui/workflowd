#!/usr/bin/python3
"""Bounded normal-CLI fixture; synthetic loopback upstream and private PTY only."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time
from urllib.parse import urlsplit


def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def main():
    os.umask(0o077)
    assert os.readlink('/proc/self/ns/net') != os.environ['WORKFLOWD_FIXTURE_HOST_NETNS']
    request = json.loads(sys.stdin.read(65537))
    binary = Path(request['binary'])
    with binary.open('rb') as artifact:
        assert hashlib.file_digest(artifact, 'sha256').hexdigest() == 'bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222'
    assert urlsplit(request['baseUrl']).hostname == '127.0.0.1'
    arguments = request['arguments']
    assert all(value not in ['-p', '--print', '--output-format', '--input-format'] for value in arguments)
    home, directory = Path(request['home']), Path(request['directory'])
    events = Path(request['pty'] + '.hooks')
    hook = Path(request['pty'] + '.py')
    hook.write_text('import sys\nfrom pathlib import Path\nwith Path(' + repr(str(events)) + ').open("a") as out: out.write(sys.stdin.read().strip()+"\\n")\n')
    (home / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'autoUpdates': False,
        'projects': {str(directory): {'hasTrustDialogAccepted': True}},
    }))
    command = shlex.join(['/usr/bin/python3', str(hook)])
    settings = {'hooks': {name: [{'hooks': [{'type': 'command', 'command': command, 'timeout': 5}]}] for name in ['SessionStart', 'Stop']}}
    env = {key: value for key, value in os.environ.items() if key in [
        'PATH', 'LANG', 'TMPDIR', 'WORKFLOWD_RUN_ID', 'WORKFLOWD_WORKER_GITHUB_SOCKET', 'GH_CONFIG_DIR'
    ] or key.startswith('GIT_')}
    env.update({
        'HOME': str(home), 'TERM': 'xterm-256color',
        'CLAUDE_CODE_OAUTH_TOKEN': 'synthetic-oauth-sentinel',
        'ANTHROPIC_BASE_URL': request['baseUrl'],
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
    })
    args = [str(binary), '--model', request.get('model','claude-opus-4-6'), '--effort', request.get('effort','high'),
            '--permission-mode', 'dontAsk', '--no-chrome', '--disable-slash-commands',
            '--settings', json.dumps(settings), *arguments,
            '--resume' if request['resume'] else '--session-id', request['session'],
            request.get('prompt','Reply with the fixture completion.')]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
    child = subprocess.Popen(args, cwd=directory, env=env, stdin=slave, stdout=slave,
                             stderr=slave, preexec_fn=terminal)
    os.close(slave)
    capture = bytearray()
    stopped = False
    transcript = None
    dispatch = Path(request['dispatchEvents']) if request.get('dispatchEvents') else None
    copied = 0
    started = False
    tokens = 0
    final_text = ''
    def interrupted(_signal, _frame):
        raise InterruptedError('Interactive fixture cancelled')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    if dispatch:
        dispatch.write_text('')
    try:
        deadline = time.monotonic() + 25
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try: capture.extend(os.read(master, 65536))
                except OSError: break
                if len(capture) > 1048576: raise ValueError('Private PTY capacity')
            if events.exists():
                if events.stat().st_size > 65536: raise ValueError('Hook capacity')
                for line in events.read_text().splitlines():
                    event = json.loads(line)
                    assert event['session_id'] == request['session']
                    transcript = Path(event['transcript_path'])
                    if event['hook_event_name'] == 'Stop' and not stopped:
                        stopped = True
                        os.write(master, b'\x04\x04')
                        deadline = time.monotonic() + 5
            if dispatch and transcript and transcript.exists():
                assert transcript.stat().st_size <= 2097152
                lines = transcript.read_text().splitlines()
                with dispatch.open('a') as output:
                    for line in lines[copied:]:
                        record = json.loads(line)
                        if record.get('type') == 'assistant':
                            message = record['message']
                            if not started:
                                output.write(json.dumps({'type': 'system', 'subtype': 'init',
                                    'session_id': request['session'], 'model': message['model']}) + '\n')
                                started = True
                            tokens += message.get('usage', {}).get('output_tokens', 0)
                            final_text = ''.join(part.get('text', '') for part in message.get('content', []))
                        output.write(line + '\n')
                    copied = len(lines)
        child.wait(timeout=1)
        assert stopped and child.returncode == 0, 'Native turn/closure unconfirmed'
        assert transcript is not None and transcript.stat().st_size <= 2097152
        Path(request['transcript']).write_bytes(transcript.read_bytes())
        if dispatch:
            assert started
            with dispatch.open('a') as output:
                output.write(json.dumps({'type': 'result', 'is_error': False,
                    'result': final_text, 'usage': {'output_tokens': tokens}}) + '\n')
        print(json.dumps({'session': request['session'], 'exitCode': child.returncode}))
    finally:
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.close(master)
        Path(request['pty']).write_bytes(capture)


if __name__ == '__main__':
    main()
