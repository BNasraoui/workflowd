#!/usr/bin/python3
"""Normal-PTY credential fixture. Preserve the caller's synthetic auth inputs.

Hold mode exposes the exact owned CLI PID for executable/UID matching, then joins
on stdin closure. Refresh mode waits for its fixture Stop hook and clean CLI exit.
All records are private fixture data, never production completion authority.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import time


def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def main():
    os.umask(0o077)
    assert {name for _, name in socket.if_nameindex()} == {'lo'}, 'Isolated loopback required'
    raw = sys.stdin.buffer.readline(65537)
    assert len(raw) <= 65536 and raw.endswith(b'\n')
    request = json.loads(raw)
    assert request['mode'] in ['hold', 'refresh'] and 1 <= request['seconds'] <= 20
    binary = Path(request['binary'])
    with binary.open('rb') as artifact:
        assert hashlib.file_digest(artifact, 'sha256').hexdigest() == 'bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222'
    assert all(value not in ['-p', '--print', '--output-format', '--input-format'] for value in request['arguments'])
    home, directory = Path(request['home']), Path(request['directory'])
    (Path(os.environ.get('CLAUDE_CONFIG_DIR', str(home))) / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'autoUpdates': False,
        'projects': {str(directory): {'hasTrustDialogAccepted': True}},
    }))
    capture = Path(request['capture'])
    hook, stopped = Path(str(capture) + '.py'), Path(str(capture) + '.stop')
    hook.write_text('from pathlib import Path\nPath(' + repr(str(stopped)) + ').touch()\n')
    settings = {'hooks': {'Stop': [{'hooks': [{'type': 'command',
        'command': shlex.join(['/usr/bin/python3', str(hook)]), 'timeout': 5}]}]}}
    args = [str(binary), '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config',
            '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--no-chrome',
            '--disable-slash-commands', '--settings', json.dumps(settings), *request['arguments']]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
    child = subprocess.Popen(args, cwd=directory,
        env={**os.environ, 'TERM': 'xterm-256color', 'DISABLE_AUTOUPDATER': '1',
             'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'},
        stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
    os.close(slave)
    output = bytearray()
    def interrupted(_signal, _frame):
        raise InterruptedError('Interactive observer cancelled')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        Path(request['ready']).write_text(json.dumps({'pid': child.pid}))
        deadline = time.monotonic() + request['seconds']
        closing = False
        while child.poll() is None:
            if time.monotonic() >= deadline:
                raise TimeoutError('Interactive observation deadline')
            watched = [master, sys.stdin] if request['mode'] == 'hold' else [master]
            readable = select.select(watched, [], [], 0.05)[0]
            if sys.stdin in readable and not os.read(sys.stdin.fileno(), 1):
                assert request['mode'] == 'hold'
                break
            if master in readable:
                try: output.extend(os.read(master, 65536))
                except OSError: break
                assert len(output) <= 1048576, 'Private PTY capacity'
            if request['mode'] == 'refresh' and stopped.exists() and not closing:
                os.write(master, b'\x04\x04')
                closing = True
        if request['mode'] == 'refresh':
            child.wait(timeout=2)
            assert stopped.exists() and child.returncode == 0, 'Interactive refresh closure unconfirmed'
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
        capture.write_bytes(output)
    print(json.dumps({'pid': child.pid, 'joined': True}))


if __name__ == '__main__':
    main()
