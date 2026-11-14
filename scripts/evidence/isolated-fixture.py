#!/usr/bin/python3
"""Bounded Linux fixture custody. Never exposes a host bus, engine or real HOME."""
import hashlib
import json
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
    pinned_publisher = os.environ.get('WORKFLOWD_FIXTURE_PINNED_PUBLISHER') == '1'
    if pinned_publisher:
        target = evidence / 'pinned-publisher'
        target.mkdir(mode=0o700)
        for name in ['publish.mjs', 'publication.mjs', 'publication-unicode.json', 'result.py', 'casefold.json']:
            data = subprocess.check_output(['git', 'show', 'f74e0505155bc32aa2cedef00ba8b08ef1b90007:deploy/sandbox/' + name], cwd=repo, timeout=10)
            (target / name).write_bytes(data)
    binaries = {name: executable(name) for name in ["bun", "node", "noscope"]}
    for name, expected in {
        'codex': 'f1cd7fa4ac866c724122f173d408a95385257cbcc9ac5ce5ddba42669c74ba97',
        'codex-code-mode-host': '37703ae51e202c07681e205bc6a8f3c04e63aee4f8ddeb8d2fb09a4d69c00b48',
        'opencode2': '5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c',
    }.items():
        if os.environ.get('WORKFLOWD_FIXTURE_' + name.upper()):
            binary = executable(name)
            with open(binary, 'rb') as artifact:
                if hashlib.file_digest(artifact, 'sha256').hexdigest() != expected:
                    raise SystemExit('Native fixture pin mismatch: ' + name)
            binaries[name] = binary
    if os.environ.get("WORKFLOWD_FIXTURE_CLAUDE"):
        claude = executable("claude")
        with open(claude, "rb") as artifact:
            digest = hashlib.file_digest(artifact, "sha256").hexdigest()
        if digest != "bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222":
            raise SystemExit("Expected official Claude 2.1.301 linux-x64 executable")
        binaries["claude"] = claude
    binds = []
    fixture_env = []
    if pinned_publisher:
        fixture_env.extend(['--setenv', 'WORKFLOWD_FIXTURE_PINNED_PUBLISHER', '/tmp/opencode/evidence/pinned-publisher'])
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
    (evidence / "invocation.json").write_text(json.dumps({"unit": unit, "command": outer}, indent=2))
    result = subprocess.run(outer, check=False, timeout=200)
    (evidence / "exit.json").write_text(json.dumps({"exit": result.returncode}))
    print(f"isolated unit={unit} evidence={evidence} exit={result.returncode}", flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
