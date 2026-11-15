"""Fixture-only kernel socket filter derived from the reviewed source unit/drop-in.

This exercises libseccomp, not systemd's unit loader or a deployed service.
"""
import ctypes
import errno
import os
import pathlib
import socket
import sys

host = os.environ.get("WORKFLOWD_FIXTURE_HOST_NETNS", "")
if not host.startswith("net:[") or host == os.readlink("/proc/self/ns/net"):
    raise RuntimeError("isolated fixture required")
families = set()
for name in sys.argv[1:3]:
    if name == "-":
        continue
    for line in pathlib.Path(name).read_text().splitlines():
        if line.startswith("RestrictAddressFamilies="):
            value = line.partition("=")[2].split()
            if value:
                families.update(value)
            else:
                families.clear()
if not families or not families <= {"AF_UNIX", "AF_INET", "AF_INET6"}:
    raise RuntimeError("unsupported fixture unit contract")

class Compare(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint),
                ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Compare)]
lib.seccomp_load.argtypes = [ctypes.c_void_p]
lib.seccomp_release.argtypes = [ctypes.c_void_p]
context = lib.seccomp_init(0x7FFF0000)
if not context:
    raise RuntimeError("seccomp unavailable")
try:
    for syscall in [b"socket", b"socketpair"]:
        for family in ["AF_INET", "AF_INET6", "AF_NETLINK"]:
            if family not in families:
                rule = Compare(0, 4, getattr(socket, family), 0)
                if lib.seccomp_rule_add_array(context, 0x50000 | errno.EAFNOSUPPORT, lib.seccomp_syscall_resolve_name(syscall), 1, ctypes.byref(rule)) != 0:
                    raise RuntimeError("seccomp rule refused")
    if ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) != 0 or lib.seccomp_load(context) != 0:
        raise RuntimeError("seccomp load refused")
finally:
    lib.seccomp_release(context)

for family in ["AF_INET", "AF_INET6", "AF_NETLINK"]:
    try:
        with socket.socket(getattr(socket, family), socket.SOCK_STREAM):
            if family not in families:
                raise RuntimeError("forbidden family allowed")
    except OSError as error:
        if family in families or error.errno != errno.EAFNOSUPPORT:
            raise
if len(sys.argv) > 3:
    os.execv(sys.argv[3], sys.argv[3:])
print("fixture socket families verified")
