#!/usr/bin/env python3
"""OpenCode 1.18.27 isolated server prompt_async probe."""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]

def api(base, method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
        body = response.read()
        return response.status, json.loads(body) if body else None

def wait_idle(base, session, directory, expected_assistants):
    for _ in range(120):
        status, result = api(base, "GET", f"/session/status?directory={directory}")
        state = result.get(session, {}).get("type", "idle")
        if state == "idle":
            messages = api(base, "GET", f"/session/{session}/message?directory={directory}")[1]
            assistants = [x for x in messages if x["info"]["role"] == "assistant" and x["info"].get("time", {}).get("completed")]
            if len(assistants) >= expected_assistants:
                text = "".join(part.get("text", "") for part in assistants[-1]["parts"] if part.get("type") == "text")
                return text
        time.sleep(0.5)
    messages = api(base, "GET", f"/session/{session}/message?directory={directory}")[1]
    print(json.dumps({"event": "timeout_diagnostics", "status": result.get(session), "messages": [{"role": x.get("info", {}).get("role"), "model": x.get("info", {}).get("modelID"), "error": x.get("info", {}).get("error"), "completed": x.get("info", {}).get("time", {}).get("completed")} for x in messages]}))
    raise TimeoutError("OpenCode session did not become idle")

def main():
    (ROOT / ".scratch").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="opencode-inbox-", dir=ROOT / ".scratch") as temp:
        scratch = pathlib.Path(temp)
        data = scratch / "data"
        auth = data / "opencode/auth.json"
        auth.parent.mkdir(parents=True)
        shutil.copyfile(pathlib.Path.home() / ".local/share/opencode/auth.json", auth)
        os.chmod(auth, 0o600)
        config = scratch / "config"
        config.mkdir()
        (config / "opencode").mkdir()
        (config / "opencode/opencode.json").write_text('{"$schema":"https://opencode.ai/config.json","model":"opencode/big-pickle"}')
        work = scratch / "work"
        work.mkdir()
        env = dict(os.environ, XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(config), XDG_CACHE_HOME=str(scratch / "cache"), OPENCODE_DISABLE_PROJECT_CONFIG="1")
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        with (scratch / "server.log").open("w") as log:
            server = subprocess.Popen(["opencode", "serve", "--pure", "--hostname", "127.0.0.1", "--port", str(port)], cwd=work, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        api(base, "GET", "/global/health")
                        break
                    except Exception:
                        if server.poll() is not None:
                            raise RuntimeError((scratch / "server.log").read_text()[-2000:])
                        time.sleep(0.1)
                directory = str(work)
                session = api(base, "POST", f"/session?directory={directory}", {"title": "Inbox probe"})[1]["id"]
                for expected_assistants, (word, prompt) in enumerate([("READY", "Reply exactly READY."), ("RECEIVED", "EVENT: CI succeeded. Reply exactly RECEIVED.")], 1):
                    status, _ = api(base, "POST", f"/session/{session}/prompt_async?directory={directory}", {"parts": [{"type": "text", "text": prompt}]})
                    print(json.dumps({"event": "prompt_async", "status": status, "session": session}))
                    message = wait_idle(base, session, directory, expected_assistants)
                    print(json.dumps({"event": "reply", "text": message}))
                    if word not in message:
                        raise AssertionError(f"expected {word}, got {message!r}")
            finally:
                server.terminate()  # Only the subprocess started here.
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()  # The same subprocess; never a managed server.
                    server.wait(timeout=5)

if __name__ == "__main__":
    main()
