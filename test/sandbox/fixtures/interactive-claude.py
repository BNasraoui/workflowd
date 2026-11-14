#!/usr/bin/python3
"""Pinned interactive-PTY feasibility against an offline synthetic Anthropic server."""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import threading
import time
import uuid
import sys
import socket


root = Path("/tmp/opencode/evidence")
assert os.readlink("/proc/self/ns/net") != os.environ["WORKFLOWD_FIXTURE_HOST_NETNS"]
assert not Path("/run/docker.sock").exists()
home = root / "native-home"
workspace = root / "native-workspace"
home.mkdir(mode=0o700)
workspace.mkdir(mode=0o700)
session = str(uuid.uuid4())
requests = []
turn_requests = []
actions = [
    ("Write", {"file_path": str(workspace / "result.txt"), "content": "first native tool turn\n"}),
    ("Read", {"file_path": str(workspace / "result.txt")}),
    ("Bash", {"command": "touch forbidden-command", "description": "Denied permission control"}),
]
if '--result' in sys.argv:
    import shlex
    submission_script = Path(__file__).resolve().parents[3] / 'deploy/sandbox/claude-interactive.py'
    for revision, title in [(0, 'Initial result'), (1, 'Corrected native result')]:
        payload = {'revision': revision, 'completion': {'branch': 'native/agent-choice', 'title': title, 'commitMessage': 'Native result', 'body': '## Result\n\nNative result.'}}
        actions.append(('Bash', {'command': shlex.join(['python3', str(submission_script), 'submit', json.dumps(payload)]), 'description': 'Submit native result candidate'}))


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        requests.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
        if self.path.split("?")[0] != "/v1/messages":
            self.send_response(404)
            self.end_headers()
            return
        main = bool(json.loads(body).get("tools"))
        if main:
            turn_requests.append(requests[-1])
        n = len(turn_requests)
        action = actions.pop(0) if main and actions else None
        model = json.loads(body)["model"]
        call = "tool_" + str(n)
        block = {"type": "tool_use", "id": call, "name": action[0], "input": {}} if action else {"type": "text", "text": ""}
        delta = {"type": "input_json_delta", "partial_json": json.dumps(action[1])} if action else {"type": "text_delta", "text": "native-fixture-complete" if main else "Synthetic fixture"}
        events = [
            {"type": "message_start", "message": {"id": "msg_" + str(n), "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": block},
            {"type": "content_block_delta", "index": 0, "delta": delta},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use" if action else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}},
            {"type": "message_stop"},
        ]
        output = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(output)))
        self.send_header("request-id", "req_synthetic_" + str(n))
        self.end_headers()
        self.wfile.write(output)


class UnixModel(ThreadingHTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name, self.server_port = 'fixture', 0


gateway_socket = str(root / 'native-gateway.sock')
server = UnixModel(gateway_socket, Model) if '--gateway' in sys.argv and '--external' not in sys.argv else ThreadingHTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
expected_bearer = 'synthetic-oauth-sentinel'
if '--external' in sys.argv:
    print(json.dumps({'upstream': 'http://127.0.0.1:' + str(server.server_port)}), flush=True)
    external = json.loads(sys.stdin.readline())
    gateway_socket, expected_bearer = external['socket'], external['bearer']
    session = external['session']
stop_file = home / "stops.jsonl"
hook = home / "stop.py"
hook.write_text('import json,sys\nfrom pathlib import Path\ne=json.load(sys.stdin)\nwith Path(' + repr(str(stop_file)) + ').open("a") as f: f.write(json.dumps({"event":e["hook_event_name"],"session":e["session_id"]})+"\\n")\n')
(home / ".claude.json").write_text(json.dumps({
    "hasCompletedOnboarding": True, "theme": "dark", "autoUpdates": False,
    "projects": {str(workspace): {"hasTrustDialogAccepted": True}},
}))
env = {k: os.environ[k] for k in ["PATH", "LANG", "TMPDIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]}
env.update({
    "HOME": str(home),
    "TERM": "xterm-256color", "CLAUDE_CODE_OAUTH_TOKEN": "synthetic-oauth-sentinel",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:" + str(server.server_port),
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1",
})
base_args = [
    "claude", "--model", "claude-opus-4-6", "--effort", "high",
    "--permission-mode", "dontAsk", "--tools", "Read,Write,Bash",
    "--allowedTools", "Read", "Write", "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
    "--disable-slash-commands", "--no-chrome",
    "--settings", json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/usr/bin/python3 " + str(hook), "timeout": 5}]}]}}),
]


def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def run(name, args, completed, graceful):
    if '--supervised' in sys.argv:
        return supervised(name, args, completed, graceful)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    child = subprocess.Popen(args, cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
    os.close(slave)
    capture = bytearray()
    reached = False
    try:
        deadline = time.monotonic() + 35
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    capture.extend(os.read(master, 65536))
                except OSError:
                    break
            if len(capture) > 1024 * 1024:
                raise RuntimeError("PTY capture exceeded private byte budget")
            if not reached and completed():
                reached = True
                if graceful:
                    os.write(master, b"\x04\x04")
                    deadline = time.monotonic() + 5
                else:
                    break
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)
        os.close(master)
        (root / (name + ".pty")).write_bytes(capture)
        (root / (name + "-launch.json")).write_text(json.dumps({"args": args, "session": session, "exit": child.returncode, "reached": reached}, indent=2))
    assert reached, "Native outcome not observed before bound: " + name
    if graceful:
        assert child.returncode == 0, "Native terminal exit was not confirmed"
    return capture


def supervised(name, args, completed, graceful):
    script = Path(__file__).resolve().parents[3] / 'deploy/sandbox/claude-interactive.py'
    child = subprocess.Popen(['/usr/bin/python3', str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    request = {
        'binary': os.environ['WORKFLOWD_FIXTURE_CLAUDE'], 'home': str(home), 'workspace': str(workspace),
        'session': session, 'model': 'claude-opus-4-6', 'effort': 'high', 'prompt': args[-1],
        'resume': name != 'turns', 'baseUrl': {'socket': gateway_socket} if '--gateway' in sys.argv else env['ANTHROPIC_BASE_URL'],
        'sentinel': 'synthetic-oauth-sentinel', 'deadline': time.time() + 40,
        'tools': ['Read', 'Write', 'Bash'],
        'allowedTools': ['Read', 'Write', *(['Bash(python3 *)'] if not graceful or '--result' in sys.argv else [])],
    }
    child.stdin.write(json.dumps(request).encode() + b'\n')
    child.stdin.flush()
    capture, events, buffer = bytearray(), [], b''
    reached = False
    try:
        deadline = time.monotonic() + 45
        while child.poll() is None and time.monotonic() < deadline:
            for stream in select.select([child.stdout, child.stderr], [], [], 0.05)[0]:
                data = os.read(stream.fileno(), 65536)
                if stream is child.stderr:
                    capture.extend(data)
                else:
                    buffer += data
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        events.append(json.loads(line))
            if len(capture) > 1024**2: raise RuntimeError('Private capture exceeded bound')
            # The fixture controller explicitly closes after its known synthetic
            # sequence/child marker. Hooks are advisory, never adapter authority.
            observed = any(e['event'] == 'started' for e in events)
            if not reached and completed() and observed:
                reached = True
                child.stdin.write(json.dumps({'operation': 'finish' if graceful else 'cancel'}).encode() + b'\n')
                child.stdin.flush()
        out, err = child.communicate(timeout=2)
        capture.extend(err)
        events.extend(json.loads(line) for line in (buffer + out).splitlines())
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=2)
        (root / (name + '.pty')).write_bytes(capture)
        (root / (name + '-events.json')).write_text(json.dumps(events))
    assert reached, 'Supervised native outcome not observed: ' + name
    assert child.returncode == 0
    assert events[0] == {'event': 'started', 'session': session}
    assert all(e['event'] in ['started','closed'] for e in events), 'Advisory data promoted to lifecycle evidence'
    assert events[-1]['event'] == 'closed'
    assert events[-1]['outcome'] == ('completed' if graceful else 'cancelled')
    if graceful: assert events[-1]['exitCode'] == 0
    return capture


def stops():
    return [json.loads(line) for line in stop_file.read_text().splitlines()] if stop_file.exists() else []


try:
    initial = "Execute the synthetic tool sequence, then finish."
    capture = run("turns", [*base_args, "--session-id", session, "--", initial], lambda: len(stops()) == 1, True)
    initial_requests = 6 if '--result' in sys.argv else 4
    assert len(turn_requests) == initial_requests, "Interactive CLI did not execute the synthetic multi-turn sequence"
    assert (workspace / "result.txt").read_text() == "first native tool turn\n"
    assert not (workspace / "forbidden-command").exists()
    assert b"native-fixture-complete" in capture
    results = [r["body"]["messages"][-1]["content"][0] for r in turn_requests[1:]]
    assert not results[0].get("is_error") and not results[1].get("is_error")
    assert results[2]["is_error"] and "don't ask mode" in results[2]["content"]
    if '--result' in sys.argv:
        assert all(not result.get('is_error') for result in results[3:]), 'Native result tool failed'

    actions.append(("Read", {"file_path": str(workspace / "result.txt")}))
    resumed = "Read the existing result and finish this resumed turn."
    capture = run("resume", [*base_args, "--resume", session, "--", resumed], lambda: len(stops()) == 2, True)
    assert len(turn_requests) == initial_requests + 2
    assert b"native-fixture-complete" in capture
    content = [c for m in turn_requests[initial_requests]["body"]["messages"] for c in m["content"]]
    assert sum(c.get("text") == initial for c in content) == 1
    assert sum(c.get("text") == resumed for c in content) == 1
    assert stops() == [{"event": "Stop", "session": session}] * 2

    # One explicitly allowed long-running command proves cancellation reaches a real tool child.
    pid_file = workspace / "child.pid"
    child_code = "import os,time;open(" + repr(str(pid_file)) + ",'w').write(str(os.getpid()));time.sleep(120)"
    command = "python3 -c " + __import__("shlex").quote(child_code)
    actions.append(("Bash", {"command": command, "description": "Owned cancellation control"}))
    run("cancel", [*base_args, "--allowedTools", "Read", "Write", "Bash(python3 *)", "--resume", session, "--", "Start the bounded cancellation control."], pid_file.exists, False)
    pid = int(pid_file.read_text())
    process = Path("/proc") / str(pid) / "stat"
    deadline = time.monotonic() + 2
    while process.exists() and time.monotonic() < deadline:
        if process.read_text().split(") ")[1].startswith("Z "):
            break
        time.sleep(0.01)
    assert not process.exists() or process.read_text().split(") ")[1].startswith("Z "), "Native tool child survived cancellation"
    for request in requests:
        headers = {k.lower(): v for k, v in request["headers"].items()}
        assert headers["authorization"] == "Bearer " + expected_bearer
        assert "x-api-key" not in headers
        assert "oauth-2025-04-20" in headers["anthropic-beta"]
        assert headers["x-claude-code-session-id"] == session
        assert request["body"]["model"] == "claude-opus-4-6"
    assert turn_requests[0]["body"]["thinking"]["type"] == "adaptive"
    assert turn_requests[0]["body"]["output_config"]["effort"] == "high"
    print(json.dumps({"version": "2.1.301", "interactive": True, "requests": len(requests), "sameSessionResume": True, "cancelledChild": True}))
finally:
    server.shutdown()
    server.server_close()
    (root / "requests.json").write_text(json.dumps(requests, indent=2))
