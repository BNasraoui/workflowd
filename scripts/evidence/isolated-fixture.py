#!/usr/bin/python3
"""Bounded Linux fixture custody. Never exposes a host bus, engine or real HOME."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid


def executable(name):
    value = os.environ.get("WORKFLOWD_FIXTURE_" + name.upper()) or shutil.which(name)
    if not value:
        raise SystemExit("Missing fixture executable: " + name)
    path = Path(value).resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise SystemExit("Invalid fixture executable: " + name)
    return str(path)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: isolated-fixture.py COMMAND [ARGS...]")
    os.umask(0o077)
    repo = Path(__file__).resolve().parents[2]
    mountpoint = repo / '.scratch'
    if mountpoint.is_symlink():
        raise SystemExit('Fixture scratch mountpoint must be a directory')
    mountpoint.mkdir(mode=0o700, exist_ok=True)
    evidence_parent = Path(os.environ.get("WORKFLOWD_FIXTURE_EVIDENCE", "/tmp/opencode"))
    evidence_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="wfd-isolated-", dir=evidence_parent))
    scratch = evidence / "scratch"
    scratch.mkdir(mode=0o700)
    binaries = {name: executable(name) for name in ["bun", "node", "noscope"]}
    binds = []
    fixture_env = []
    for name, path in binaries.items():
        # Individual executable files only, never a user's package/config directory.
        binds.extend(["--ro-bind", path, "/opt/wfd-fixture/bin/" + name])
        fixture_env.extend(["--setenv", "WORKFLOWD_FIXTURE_" + name.upper(), "/opt/wfd-fixture/bin/" + name])
    command = [
        executable("bwrap"), "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/", "/", "--tmpfs", "/home", "--tmpfs", "/root",
        "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/opt", "--proc", "/proc", "--dev", "/dev",
        "--ro-bind", str(repo), str(repo), "--bind", str(scratch), str(repo / ".scratch"),
        *binds, "--bind", str(evidence), "/tmp/opencode/evidence",
        "--dir", "/tmp/fixture-home", "--dir", "/tmp/fixture-runtime",
        "--dir", "/tmp/fixture-tmp", "--chmod", "0700", "/tmp/fixture-runtime",
        "--clearenv", "--setenv", "PATH", "/opt/wfd-fixture/bin:/usr/bin:/bin",
        *fixture_env,
        "--setenv", "HOME", "/tmp/fixture-home", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "TMPDIR", "/tmp/fixture-tmp",
        "--setenv", "XDG_RUNTIME_DIR", "/tmp/fixture-runtime",
        "--setenv", "DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/fixture-runtime/no-bus",
        "--setenv", "DOCKER_HOST", "unix:///tmp/fixture-runtime/no-docker",
        "--setenv", "WORKFLOWD_FIXTURE_HOST_NETNS", os.readlink("/proc/self/ns/net"),
        "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null",
        "--setenv", "GIT_TERMINAL_PROMPT", "0", "--setenv", "GIT_CONFIG_COUNT", "1",
        "--setenv", "GIT_CONFIG_KEY_0", "core.hooksPath", "--setenv", "GIT_CONFIG_VALUE_0", "/dev/null",
        "--setenv", "GIT_AUTHOR_NAME", "Workflowd Agent", "--setenv", "GIT_COMMITTER_NAME", "Workflowd Agent",
        "--setenv", "GIT_AUTHOR_EMAIL", "agent@workflowd.invalid", "--setenv", "GIT_COMMITTER_EMAIL", "agent@workflowd.invalid",
        "--chdir", str(repo), "--",
        executable("unshare"), "--user", "--map-current-user", "--keep-caps", "--net",
        "/bin/sh", "-c", 'ip link set lo up && ip addr add 100.64.0.1/32 dev lo && exec "$@"',
        "wfd-fixture", *sys.argv[1:],
    ]
    unit = "wfd-isolated-" + uuid.uuid4().hex[:12]
    outer = [
        executable("systemd-run"), "--user", "--quiet", "--wait", "--pipe", "--collect",
        "--unit=" + unit, "-p", "MemoryMax=6G", "-p", "MemorySwapMax=0",
        "-p", "CPUQuota=200%", "-p", "TasksMax=512",
        "-p", "RuntimeMaxSec=180s", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", *command,
    ]
    return subprocess.run(outer, check=False, timeout=200).returncode


if __name__ == "__main__":
    raise SystemExit(main())
