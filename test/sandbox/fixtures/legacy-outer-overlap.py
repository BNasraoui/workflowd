"""Actual outer-shell orchestration at synthetic Docker boundaries, in isolation."""
import ast
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest


HERE = Path(__file__).resolve()
SHELL_HASH = '01a989eb4d1d04b0d146c790ac536abd88f374ec74a2e110c58910b840d42045'
LIBC_HASH = '095b047c631447e4fa50401fa7ffce01f678587040d65ba18c574981dc630de5'


def shell_command():
    directory = Path(os.environ['WORKFLOWD_OVERLAP_SHELL_DIR'])
    for name, digest in [('busybox', SHELL_HASH), ('ld-musl-x86_64.so.1', LIBC_HASH)]:
        assert hashlib.sha256((directory / name).read_bytes()).hexdigest() == digest
    return [str(directory / 'ld-musl-x86_64.so.1'), '--library-path', str(directory),
            str(directory / 'busybox'), 'sh']


def rpc(message):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(12)
        connection.connect(os.environ['OVERLAP_BOUNDARY'])
        connection.sendall(json.dumps(message).encode() + b'\n')
        with connection.makefile('rb') as stream:
            return json.loads(stream.readline(65536))


def daemon():
    """Own a real late child and its Unix socket; TERM closes and reaps them."""
    directory = Path(os.environ['OVERLAP_DIRECTORY'])
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    children = []
    listener = socket.socket(socket.AF_UNIX)
    address = directory / 'daemon.sock'
    listener.bind(str(address))
    listener.listen(1)
    rpc({'event': 'daemon-ready'})
    try:
        while not stopping:
            if not select.select([listener], [], [], .05)[0]:
                continue
            connection, _ = listener.accept()
            with connection:
                assert connection.recv(64) == b'create-child'
                child = subprocess.Popen([sys.executable, str(HERE), '--worker'],
                                         stdout=subprocess.PIPE)
                children.append(child)
                assert select.select([child.stdout], [], [], 3)[0]
                assert child.stdout.readline() == b'ready\n'
                connection.sendall(str(child.pid).encode())
    finally:
        for child in children:
            child.terminate()
            assert child.wait(timeout=3) == 0
        listener.close()
        address.unlink()
        assert not (directory / 'late.sock').exists()
        (directory / 'daemon-stopped.json').write_text(json.dumps({
            'children': [child.pid for child in children],
            'statuses': [child.returncode for child in children], 'socketAbsent': True}))


def worker():
    address = Path(os.environ['OVERLAP_DIRECTORY']) / 'late.sock'
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(address))
    listener.listen(1)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        print('ready', flush=True)
        signal.pause()
    finally:
        listener.close()
        address.unlink()


def adapter():
    name, arguments = sys.argv[2], sys.argv[3:]
    if name == 'sh':
        os.execv(shell_command()[0], [*shell_command(), *arguments])
    if name == 'dockerd':
        daemon()
        return
    if name in ['ln', 'cp', 'chmod']:
        # Only the actual shared preparation uses these synthetic boundaries.
        assert (name, arguments[0]) in [('ln', '-s'), ('cp', '-f'), ('chmod', '0755'),
                                       ('chmod', '0600')]
        return
    assert name == 'docker'
    response = rpc({'event': 'docker', 'arguments': arguments})
    sys.stdout.write(response.get('stdout', ''))
    raise SystemExit(response['status'])


class OuterOverlap(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.readlink('/proc/self/ns/net'),
                            os.environ['WORKFLOWD_FIXTURE_HOST_NETNS'])
        shell_command()
        self.directory = Path(tempfile.mkdtemp(prefix='overlap-',
                              dir='/tmp/opencode/evidence'))
        self.events = []
        self.pending = {}
        self.pidfds = {}
        self.children = []
        self.rescue = False
        self.observation = b''
        self.parent = None
        self.import_pid = None
        self.insertions = []
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(self.directory / 'boundary.sock'))
        self.listener.listen(16)
        self.observed, self.observe = os.pipe()
        self.release, self.releasing = os.pipe()
        self.deadline = time.monotonic() + 12

    def tearDown(self):
        # Rescue is never evidence of the production join/shutdown behavior.
        for descriptor in self.pidfds.values():
            if not select.select([descriptor], [], [], 0)[0]:
                self.rescue = True
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        for child in self.children:
            output, error = child.communicate(timeout=3)
            (self.directory / 'probe-output.json').write_text(json.dumps({
                'status': child.returncode, 'stdout': output.decode(), 'stderr': error.decode()}))
        for connection, _ in self.pending.values():
            connection.close()
        for descriptor in [*self.pidfds.values(), self.observed, self.observe,
                           self.release, self.releasing]:
            os.close(descriptor)
        self.listener.close()
        (self.directory / 'events.json').write_text(json.dumps(self.events, indent=2))
        (self.directory / 'rescue.json').write_text(json.dumps({'used': self.rescue}))

    def own(self, pid):
        if pid not in self.pidfds:
            self.pidfds[pid] = os.pidfd_open(pid)
        return self.pidfds[pid]

    def inject(self, text, anchor, block):
        self.assertEqual(text.count(anchor), 1)
        result = text.replace(anchor, block + anchor)
        self.assertEqual(result.replace(block, '', 1), text)
        self.insertions.append(block)
        return result

    def launch(self, registration=False):
        source = Path('scripts/evidence/legacy-outer.sh').read_text()
        self.assertEqual(source.count('phase() {\n'), 1)
        fragment = 'set -eu\n' + source[source.index('phase() {\n'):]
        # Keep both privileged scripts byte-identical as opaque Docker arguments.
        scripts = []
        for start, end in [("--entrypoint /bin/sh \"$controller\" -ec '", "\n  ')") ,
                           ("timeout \"$remaining\" /bin/sh -ec '",
                            "\n' > /evidence/controller-setup.log")]:
            self.assertEqual(fragment.count(start), 1)
            begin = fragment.index(start) + len(start)
            finish = fragment.index(end, begin)
            body = fragment[begin:finish]
            token = '__OPAQUE_CONTROLLER_' + str(len(scripts)) + '__'
            scripts.append((token, body))
            fragment = fragment[:begin] + token + fragment[finish:]
        fragment = re.sub(r'(?<![/\w-])/evidence\b', str(self.directory / 'evidence'), fragment)
        fragment = fragment.replace('/source/legacy', str(self.directory / 'legacy'))
        for token, body in scripts:
            fragment = fragment.replace(token, body)
        original = fragment
        observe = str(self.observe)
        parent_observation = f"printf 'parent %s\\n' \"$$\" >&{observe}\n"
        fragment = parent_observation + fragment
        self.insertions.append(parent_observation)
        if 'import_pid=$!\n' in fragment:
            if registration:
                gate = (f"printf 'boundary %s %s\\n' \"$!\" \"$import_pid\" >&{observe}\n"
                        f"if read -r gate_release <&{self.release}; then :; else\n"
                        '  test "$import_signal" = 143\n'
                        f"  printf 'latched %s\\n' \"$import_signal\" >&{observe}\n"
                        f"  read -r gate_release <&{self.release}\nfi\n"
                        'test "$gate_release" = release-registration\n')
                fragment = self.inject(fragment, 'import_pid=$!\n', gate)
            anchor = 'import_pid=$!\n'
            block = f"printf 'registered %s %s\\n' \"$import_pid\" \"$import_signal\" >&{observe}\n"
            fragment = fragment.replace(anchor, anchor + block)
            self.insertions.append(block)
            fragment = self.inject(fragment, '  trap \'\' HUP INT TERM\n',
                                   f"  printf 'draining\\n' >&{observe}\n")
            fragment = self.inject(fragment, 'import_wait_status=0\n',
                                   f"printf 'waiting\\n' >&{observe}\n")
        stripped = fragment
        for block in reversed(self.insertions):
            self.assertEqual(stripped.count(block), 1)
            stripped = stripped.replace(block, '', 1)
        self.assertEqual(stripped, original)
        (self.directory / 'projection-identity.json').write_text(json.dumps({
            'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
            'projectedSha256': hashlib.sha256(original.encode()).hexdigest(),
            'strippedSha256': hashlib.sha256(stripped.encode()).hexdigest(),
            'opaqueScriptsSha256': [hashlib.sha256(body.encode()).hexdigest()
                                    for _, body in scripts]}))
        (self.directory / 'projection.sh').write_text(original)
        (self.directory / 'outer.sh').write_text(fragment)
        (self.directory / 'observation.diff').write_text(''.join(difflib.unified_diff(
            original.splitlines(True), fragment.splitlines(True))))
        for name in ['evidence', 'legacy', 'bin']:
            (self.directory / name).mkdir()
        (self.directory / 'legacy/controller.tar').touch()
        (self.directory / 'legacy/controller-id').write_text('sha256:synthetic-controller\n')
        for name in ['docker', 'dockerd', 'sh', 'ln', 'cp', 'chmod']:
            path = self.directory / 'bin' / name
            path.write_text('#!/usr/bin/python3\nimport os\nos.execv(' + repr(sys.executable)
                            + ', ' + repr([sys.executable, str(HERE), '--adapter', name])
                            + ' + __import__("sys").argv[1:])\n')
            path.chmod(0o700)
        tree = ast.parse(Path('scripts/evidence/owned-docker.py').read_text())
        probe = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'PROBE' for t in n.targets))
        def part(start, end):
            self.assertEqual(probe.count(start), 1)
            self.assertEqual(probe.count(end), 1)
            return probe[probe.index(start):probe.index(end)]
        selected = ('set -eu\n' + part('dockerd --config-file=', 'ready=0\n')
                    + part('if test "$FIXTURE_CASE" = legacy-build ||',
                           'if test "$FIXTURE_CASE" = network ||')
                    + probe[probe.index('kill -TERM "$daemon"\n'):])
        selected = re.sub(r'(?<![/\w-])/evidence\b', str(self.directory / 'evidence'), selected)
        selected = selected.replace('/source/repo/scripts/evidence/legacy-outer.sh',
                                    str(self.directory / 'outer.sh'))
        (self.directory / 'selected-probe.sh').write_text(selected)
        environment = {**os.environ, 'PATH': str(self.directory / 'bin') + ':/usr/bin:/bin',
                       'OVERLAP_BOUNDARY': str(self.directory / 'boundary.sock'),
                       'OVERLAP_DIRECTORY': str(self.directory), 'storage': 'overlay2',
                       'FIXTURE_CASE': 'legacy-test', 'FIXTURE_OWNER': 'synthetic',
                       'FIXTURE_UID': str(os.getuid()), 'FIXTURE_GID': str(os.getgid()),
                       'HOST_NETNS': 'synthetic-net', 'HOST_CGROUPNS': 'synthetic-cgroup',
                       'FIXTURE_STARTUP_DEADLINE': str(int(time.time()) + 10),
                       'WORKFLOWD_FIXTURE_LEGACY_SUITE': 'skill-discovery',
                       'WORKFLOWD_FIXTURE_LEGACY_STARTUP': '1',
                       'WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_STAGE': '0',
                       'WORKFLOWD_FIXTURE_LEGACY_DEATH': '0', 'runtime_env': '',
                       'audit_env': '', 'temporary': str(self.directory)}
        self.probe = subprocess.Popen([*shell_command(), str(self.directory / 'selected-probe.sh')],
                                      env=environment, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, pass_fds=(self.observe, self.release))
        self.children.append(self.probe)
        self.own(self.probe.pid)

    def step(self):
        remaining = self.deadline - time.monotonic()
        self.assertGreater(remaining, 0, 'event watchdog expired; never a passing rescue')
        ready = select.select([self.listener, self.observed], [], [], remaining)[0]
        self.assertTrue(ready, 'overlap event watchdog expired')
        if self.observed in ready:
            self.observation += os.read(self.observed, 4096)
            while b'\n' in self.observation:
                raw, self.observation = self.observation.split(b'\n', 1)
                row = raw.decode().split()
                self.events.append({'observation': row})
                if row[0] == 'parent':
                    self.parent = int(row[1]); self.own(self.parent)
                if row[0] in ['boundary', 'registered']:
                    self.import_pid = int(row[1]); self.own(self.import_pid)
        if self.listener in ready:
            connection, _ = self.listener.accept()
            connection.settimeout(3)
            pid, uid, _ = struct.unpack('3i', connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            self.assertEqual(uid, os.getuid())
            self.own(pid)
            with connection.makefile('rb') as stream:
                row = json.loads(stream.readline(65536))
            row['pid'] = pid
            self.events.append(row)
            if row['event'] == 'daemon-ready':
                connection.sendall(b'{}\n'); connection.close()
                return
            args = row['arguments']
            if args[:2] == ['image', 'load']:
                name = Path(args[-1]).stem
                if name == 'controller':
                    connection.sendall(b'{"status":0}\n'); connection.close(); return
                label = name
            elif args[0] == 'create': label = 'create'
            elif args[0] == 'exec' and args[2] == 'timeout': label = 'setup'
            else:
                output = ''
                if args[:2] == ['image', 'inspect']:
                    output = 'sha256:synthetic-controller\n' if '--format' in args else '[]\n'
                if args[0] == 'inspect' and '--format' in args:
                    output = 'private 5368709120 5368709120 768\n'
                if args[0] == 'exec' and 'legacy-admission.mjs' in ' '.join(args):
                    self.events.append({'admission': True})
                connection.sendall(json.dumps({'status': 0, 'stdout': output}).encode()+b'\n')
                connection.close(); return
            self.assertNotIn(label, self.pending)
            self.pending[label] = (connection, row)

    def until(self, predicate):
        while not predicate(): self.step()

    def observation_seen(self, value):
        return any(row.get('observation', [''])[0] == value for row in self.events)

    def answer(self, name, status=0):
        connection, _ = self.pending.pop(name)
        output = ''
        if name == 'create' and status == 0:
            self.until(lambda: any(r.get('event') == 'daemon-ready' for r in self.events))
            with socket.socket(socket.AF_UNIX) as request:
                request.settimeout(3)
                request.connect(str(self.directory / 'daemon.sock'))
                request.sendall(b'create-child')
                self.own(int(request.recv(64)))
            output = 'synthetic-inner-id\n'
        connection.sendall(json.dumps({'status': status, 'stdout': output}).encode()+b'\n')
        connection.close()

    def held(self):
        self.assertIsNone(self.probe.poll())
        self.assertFalse(any(r.get('admission') for r in self.events))
        self.assertFalse((self.directory / 'daemon-stopped.json').exists())
        if self.import_pid:
            self.assertFalse(select.select([self.pidfds[self.import_pid]], [], [], 0)[0])

    def finish(self, status):
        # Pump successful downstream synthetic boundaries until actual PROBE exits.
        while self.probe.poll() is None:
            ready = select.select([self.listener, self.observed,
                                   self.pidfds[self.probe.pid]], [], [],
                                  max(0, self.deadline-time.monotonic()))[0]
            self.assertTrue(ready, 'completion watchdog expired')
            if self.pidfds[self.probe.pid] in ready: break
            self.step()
        output, error = self.probe.communicate(timeout=3)
        self.assertEqual((self.probe.returncode, output, error), (status, b'', b''))
        self.assertTrue((self.directory / 'evidence/inner-stopped').exists())
        receipt = json.loads((self.directory / 'daemon-stopped.json').read_text())
        self.assertTrue(receipt['socketAbsent'])
        self.assertFalse((self.directory / 'daemon.sock').exists())
        self.assertFalse((self.directory / 'late.sock').exists())
        for descriptor in self.pidfds.values():
            self.assertTrue(select.select([descriptor], [], [], 0)[0], 'owned process survived join')
        self.assertFalse(self.rescue)
        if status:
            self.assertFalse(any(r.get('admission') for r in self.events))
        else:
            self.assertEqual(sum(bool(r.get('admission')) for r in self.events), 1)

    def overlap(self):
        self.until(lambda: 'ubuntu' in self.pending and 'create' in self.pending)

    def test_successful_overlap_and_join(self):
        self.launch(); self.overlap()
        self.answer('ubuntu'); self.answer('create')
        self.until(lambda: 'dagger' in self.pending and 'setup' in self.pending)
        self.answer('dagger'); self.answer('setup')
        self.until(lambda: 'built' in self.pending and self.observation_seen('waiting'))
        self.held()
        self.assertEqual((self.directory / 'evidence/controller-id').read_text(),
                         'synthetic-inner-id\n')
        self.answer('built'); self.finish(0)
        raw = (self.directory / 'evidence/legacy-phases.log').read_text()
        self.assertTrue(raw.endswith('\n'))
        records = []
        for line in raw.splitlines():
            match = re.fullmatch(r'([0-9]+\.[0-9]{2}) ([a-z-]+) (start|end)', line)
            self.assertIsNotNone(match, 'torn phase record')
            records.append((float(match[1]), match[2], match[3]))
        self.assertEqual(len(records), 18)
        self.assertEqual(len({(label, event) for _, label, event in records}), 18)
        for chain in [['controller-load', 'ubuntu-load', 'dagger-load', 'tooling-load',
                       'legacy-admission', 'combined-admission'],
                      ['controller-load', 'controller-create', 'controller-start',
                       'controller-setup', 'legacy-admission', 'combined-admission']]:
            selected = [(stamp, label, event) for stamp, label, event in records if label in chain]
            self.assertEqual([(label, event) for _, label, event in selected],
                             [(label, event) for label in chain for event in ['start', 'end']])
            self.assertEqual([stamp for stamp, _, _ in selected],
                             sorted(stamp for stamp, _, _ in selected))

    def test_import_failure_and_late_controller(self):
        self.launch(); self.overlap(); self.answer('ubuntu', 37); self.answer('create')
        self.until(lambda: 'setup' in self.pending)
        self.assertEqual((self.directory / 'evidence/controller-id').read_text(),
                         'synthetic-inner-id\n')
        self.answer('setup'); self.finish(37)

    def test_controller_failure_and_late_import(self):
        self.launch(); self.overlap(); self.answer('create')
        self.until(lambda: 'setup' in self.pending); self.answer('setup', 39)
        self.until(lambda: self.observation_seen('draining'))
        self.held(); self.answer('ubuntu', 37); self.finish(39)
        self.assertIn('parent=39 import=37',
                      (self.directory / 'evidence/legacy.log').read_text())

    def test_registered_parent_term_during_wait(self):
        self.launch(); self.overlap(); self.answer('create')
        self.until(lambda: 'setup' in self.pending); self.answer('setup')
        self.until(lambda: self.observation_seen('waiting'))
        signal.pidfd_send_signal(self.pidfds[self.parent], signal.SIGTERM)
        self.until(lambda: self.observation_seen('draining'))
        self.held(); self.answer('ubuntu', 37); self.finish(143)

    def test_term_between_fork_and_pid_registration(self):
        self.launch(registration=True)
        self.until(lambda: self.observation_seen('boundary') and 'ubuntu' in self.pending)
        boundary = next(r['observation'] for r in self.events if r.get('observation', [''])[0] == 'boundary')
        self.assertEqual(len(boundary), 2, 'production PID must still be empty')
        signal.pidfd_send_signal(self.pidfds[self.parent], signal.SIGTERM)
        self.until(lambda: self.observation_seen('latched'))
        self.held(); os.write(self.releasing, b'release-registration\n')
        self.until(lambda: self.observation_seen('draining'))
        registered = next(r['observation'] for r in self.events if r.get('observation', [''])[0] == 'registered')
        self.assertEqual(registered, ['registered', boundary[1], '143'])
        self.assertNotIn('create', self.pending)
        self.held(); self.answer('ubuntu', 37); self.finish(143)

    def test_import_shell_term_defers_until_client_and_parent_failure_wins(self):
        self.launch(); self.overlap()
        self.until(lambda: self.import_pid is not None)
        signal.pidfd_send_signal(self.pidfds[self.import_pid], signal.SIGTERM)
        self.answer('create')
        self.until(lambda: 'setup' in self.pending); self.answer('setup', 39)
        self.until(lambda: self.observation_seen('draining'))
        self.held(); self.answer('ubuntu'); self.finish(39)
        self.assertIn('parent=39 import=143',
                      (self.directory / 'evidence/legacy.log').read_text())
        self.assertFalse(any(r.get('arguments', [])[-1:] in [[str(self.directory / 'legacy/dagger.tar')],
                             [str(self.directory / 'legacy/built.tar')]] for r in self.events))


if __name__ == '__main__':
    if sys.argv[1:2] == ['--adapter']: adapter()
    elif sys.argv[1:2] == ['--worker']: worker()
    else: unittest.main()
