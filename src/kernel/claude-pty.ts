/**
 * Narrow PTY custodian for one interactive Claude turn, run as
 * `/usr/bin/python3 -I -c <source>` so the bundled host worker carries it. It follows
 * the established Python PTY custodians: the native child gets a private PTY and its
 * own session/process group. The launch line (argv, cwd, environment and prompt) and
 * later control operations arrive on the helper's private stdin pipe, so the prompt
 * never appears in any native argv. The prompt is submitted as one bracketed paste
 * only after Claude enables bracketed paste. Cleanup observes the leader's exit without
 * reaping it, so the signalled group identity stays pinned, then reaps it, confirms the
 * whole group is gone and drains the PTY to its real EOF before reporting `closed`.
 */
export const claudePtyHelper = String.raw`
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

LAUNCH_LIMIT = 16 * 1048576
PASTE_ON, PASTE_OFF = b'\x1b[?2004h', b'\x1b[?2004l'


def emit(event, **fields):
    sys.stdout.write(json.dumps({'event': event, **fields}, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def exited(pid):
    # WNOWAIT: observe the exit but keep the zombie leader, pinning its group id.
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def read_launch():
    buffer = b''
    while b'\n' not in buffer:
        chunk = os.read(0, 65536)
        if not chunk:
            raise EOFError('Launch closed')
        buffer += chunk
        if len(buffer) > LAUNCH_LIMIT:
            raise ValueError('Launch capacity')
    line, rest = buffer.split(b'\n', 1)
    launch = json.loads(line)
    argv, cwd, env, paste = launch['argv'], launch['cwd'], launch['env'], launch['paste']
    if not isinstance(argv, list) or not argv or not all(isinstance(value, str) for value in argv):
        raise ValueError('Invalid argv')
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ValueError('Invalid environment')
    if not isinstance(cwd, str) or not isinstance(paste, str) or not paste:
        raise ValueError('Invalid turn')
    # Literal paste only: no control character can end the paste or act as a key.
    if any((ord(c) < 32 and c not in '\t\n') or 0x7f <= ord(c) <= 0x9f for c in paste):
        raise ValueError('Prompt control characters')
    return argv, cwd, env, b'\x1b[200~' + paste.encode('utf-8') + b'\x1b[201~\r', rest


def settle(child, master, outcome):
    pid = outcome['pid'] = child.pid
    try:
        # The group is signalled only while the unreaped leader pins its identity.
        for sig, grace in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 2.0)):
            signal_group(pid, sig)
            end = time.monotonic() + grace
            while not exited(pid) and time.monotonic() < end:
                time.sleep(0.02)
        end = time.monotonic() + 2.0
        while time.monotonic() < end:
            reaped, status = os.waitpid(pid, os.WNOHANG)
            if reaped == pid:
                child.returncode = outcome['exitCode'] = os.waitstatus_to_exitcode(status)
                outcome['leaderReaped'] = True
                break
            time.sleep(0.02)
        if outcome['leaderReaped']:
            # Signal 0 only: an empty group is ESRCH, including no unreaped zombies.
            end = time.monotonic() + 5.0
            while time.monotonic() < end:
                try:
                    os.killpg(pid, 0)
                except ProcessLookupError:
                    outcome['groupEmpty'] = True
                    break
                time.sleep(0.02)
        end = time.monotonic() + 2.0
        while not outcome['outputClosed'] and time.monotonic() < end:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b''
                if not data:
                    outcome['outputClosed'] = True
                else:
                    outcome['tail'] = (outcome['tail'] + data)[-4096:]
    finally:
        os.close(master)


def stop(*_):
    raise InterruptedError('Helper signalled')


def main():
    os.umask(0o077)
    # Python handlers reset to defaults at exec, so the native child is unaffected.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    argv, cwd, env, pending, control = read_launch()
    master, slave = pty.openpty()
    child = None
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
                                 preexec_fn=terminal)
    finally:
        os.close(slave)
        if child is None:
            os.close(master)
    outcome = {'exitCode': None, 'leaderReaped': False, 'groupEmpty': False, 'outputClosed': False,
               'tail': b''}
    scan, accepting, submit, finished, cancelled, stdin_open = b'', False, False, False, False, True
    try:
        os.set_blocking(master, False)
        emit('started', pid=child.pid)
        while not cancelled and not exited(child.pid):
            for line in control.split(b'\n')[:-1]:
                op = json.loads(line).get('op')
                if op == 'submit':
                    submit = True
                elif op == 'finish' and not finished:
                    finished = True
                    os.write(master, b'\x04\x04')
                elif op == 'cancel':
                    cancelled = True
                else:
                    raise ValueError('Control refused')
            control = control.split(b'\n')[-1]
            if cancelled:
                break
            readers = ([master] if not outcome['outputClosed'] else []) + ([0] if stdin_open else [])
            writers = [master] if submit and accepting and pending else []
            readable, writable, _ = select.select(readers, writers, [], 0.05)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except BlockingIOError:
                    data = None
                except OSError:
                    data = b''
                if data == b'':
                    outcome['outputClosed'] = True
                elif data:
                    outcome['tail'] = (outcome['tail'] + data)[-4096:]
                    window = scan + data
                    on, off = window.rfind(PASTE_ON), window.rfind(PASTE_OFF)
                    if on != off:
                        accepting = on > off
                    scan = window[-(len(PASTE_ON) - 1):]
            if 0 in readable:
                chunk = os.read(0, 4096)
                if not chunk:
                    stdin_open, cancelled = False, True
                control += chunk
                if len(control) > 65536:
                    raise ValueError('Control capacity')
            if master in writable:
                try:
                    pending = pending[os.write(master, pending[:4096]):]
                except BlockingIOError:
                    pass
                if not pending:
                    emit('submitted')
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        try:
            settle(child, master, outcome)
        finally:
            tail = outcome.pop('tail').decode('utf-8', 'replace')[-1024:]
            emit('closed', **outcome, tail=tail)
    confirmed = outcome['leaderReaped'] and outcome['groupEmpty'] and outcome['outputClosed']
    return 0 if confirmed else 3


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Exception text may contain task data; report only its class.
        emit('failed', error=type(error).__name__)
        sys.exit(1)
`
