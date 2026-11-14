#!/usr/bin/python3
"""Fixed synthetic non-root filesystem proof inside the owned systemd boundary."""
import ctypes
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

assert sys.argv[1:] in [['probe'], ['test']]
mode = sys.argv[1]
assert os.getuid() == os.geteuid() == 61001
assert os.getgid() == os.getegid() == 61000
assert os.getgroups() == [61003]
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert all(int(status[key].strip(), 16) == 0 for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
assert status['NoNewPrivs'].strip() == '1'
mapping = [list(map(int, line.split())) for line in Path('/proc/self/gid_map').read_text().splitlines()]
assert any(start <= 61003 < start + count for start, outside, count in mapping)
assert all(not Path(path).exists() for path in ['/var/run/docker.sock', '/run/owned-engine/docker.sock', '/private-engine', '/gid-home/runtime/no-bus'])
try:
    Path('/root/gid-outside-canary').read_bytes()
except PermissionError:
    pass
else:
    raise AssertionError('Synthetic root canary was readable')
assert os.environ['HOME'] == '/gid-home'
assert not list(Path('/gid-home/runtime').iterdir())
libc = ctypes.CDLL('libc.so.6', use_errno=True)
sec = ctypes.CDLL('libseccomp.so.2', use_errno=True)
sec.seccomp_init.argtypes = [ctypes.c_uint32]
sec.seccomp_init.restype = ctypes.c_void_p
sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
sec.seccomp_load.argtypes = [ctypes.c_void_p]
sec.seccomp_release.argtypes = [ctypes.c_void_p]
calls = ['socket', 'connect', 'bind', 'listen', 'accept', 'accept4']
ctx = sec.seccomp_init(0x7fff0000)
assert ctx
try:
    for call in calls:
        number = sec.seccomp_syscall_resolve_name(call.encode())
        assert number >= 0 and sec.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0) == 0
    assert sec.seccomp_load(ctx) == 0
finally:
    sec.seccomp_release(ctx)
for call in calls:
    number = sec.seccomp_syscall_resolve_name(call.encode())
    assert libc.syscall(number, -1, 0, 0, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
for family in [socket.AF_UNIX, socket.AF_INET, socket.AF_INET6]:
    try:
        socket.socket(family)
    except OSError as error:
        assert error.errno == errno.EPERM
    else:
        raise AssertionError('Socket admitted')
versions = {name: subprocess.check_output(['/source/bin/' + name, '--version'], text=True).strip() for name in ['bun', 'node']}
assert versions == {'bun': '1.3.14', 'node': 'v24.11.1'}
proof = {'uid': os.getuid(), 'primaryGid': os.getgid(), 'supplementaryGids': os.getgroups(), 'gidMap': mapping, 'capabilitiesZero': True, 'socketSyscallsDenied': calls, 'syntheticOutsideCanaryDenied': True, 'hostEngineAbsent': True, 'runtimeEmpty': True, 'versions': versions, 'mode': mode}
Path('/gid-home/' + mode + '.json').write_text(json.dumps(proof, indent=2))
if mode == 'probe':
    guard = Path('/gid-home/guard.test.ts')
    guard.write_text('''import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
test("synthetic nonroot GID preload retains its resource guardian", async () => {
  expect(process.getuid!()).toBe(61001)
  expect(process.getgid!()).toBe(61000)
  expect(process.getgroups!()).toEqual([61003])
  const path = process.env.WORKFLOWD_TEST_RESOURCE_CONFIG!
  const config = JSON.parse(readFileSync(path, "utf8"))
  expect(config.owner.split(".")[5]).toBe(String(process.pid))
  const deadline = Date.now() + 4000
  while (!existsSync(join(config.directory, "guardian")) && Date.now() < deadline) await Bun.sleep(10)
  expect(existsSync(join(config.directory, "guardian"))).toBe(true)
})
''')
    target = str(guard)
else:
    target = 'test/agent-host/provider-gid.test.ts'
os.execv('/source/bin/bun', ['bun', 'test', '--reporter=junit', '--reporter-outfile=/gid-home/' + mode + '.xml', target])
