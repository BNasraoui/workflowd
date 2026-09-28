#!/usr/bin/env python3
"""Codex 0.156 resident thread probe using an isolated Unix WebSocket."""
import asyncio
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import uuid

import websockets

ROOT = pathlib.Path(__file__).resolve().parents[2]

async def request(ws, method, params):
    identifier = str(uuid.uuid4())
    await ws.send(json.dumps({"id": identifier, "method": method, "params": params}))
    while True:
        event = json.loads(await asyncio.wait_for(ws.recv(), 120))
        if event.get("id") == identifier:
            if "error" in event:
                raise RuntimeError(f"{method}: {event['error']}")
            return event["result"]
        report(event)

def report(event):
    method = event.get("method")
    params = event.get("params", {})
    if method == "item/completed" and params.get("item", {}).get("type") == "agentMessage":
        print(json.dumps({"event": "message", "text": params["item"].get("text")}))
    elif method == "turn/completed":
        print(json.dumps({"event": "turn_completed", "turn": params.get("turn", {}).get("id"), "status": params.get("turn", {}).get("status")}))
    elif method == "turn/started":
        print(json.dumps({"event": "turn_started", "turn": params.get("turn", {}).get("id")}))

async def wait_turn(ws, turn_id):
    while True:
        event = json.loads(await asyncio.wait_for(ws.recv(), 120))
        report(event)
        if event.get("method") == "turn/completed" and event.get("params", {}).get("turn", {}).get("id") == turn_id:
            return

async def main():
    (ROOT / ".scratch").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="codex-inbox-", dir=ROOT / ".scratch") as temp:
        scratch = pathlib.Path(temp)
        home = scratch / "codex-home"
        home.mkdir(mode=0o700)
        shutil.copyfile(pathlib.Path.home() / ".codex/auth.json", home / "auth.json")
        os.chmod(home / "auth.json", 0o600)
        env = dict(os.environ, CODEX_HOME=str(home))
        sock = scratch / "app.sock"
        with (scratch / "server.log").open("w") as log:
            server = subprocess.Popen(["codex", "app-server", "--listen", "unix://app.sock"], cwd=scratch, env=env, stdout=subprocess.DEVNULL, stderr=log)
            try:
                for _ in range(100):
                    if sock.exists():
                        break
                    if server.poll() is not None:
                        raise RuntimeError((scratch / "server.log").read_text())
                    await asyncio.sleep(0.1)
                previous_cwd = os.getcwd()
                os.chdir(scratch)  # AF_UNIX pathname limit excludes the long worktree prefix.
                async with websockets.unix_connect("app.sock", uri="ws://localhost/") as ws:
                    await request(ws, "initialize", {"clientInfo": {"name": "inbox-probe", "version": "0.1"}, "capabilities": {"experimentalApi": True, "requestAttestation": False}})
                    await ws.send('{"method":"initialized"}')
                    thread = (await request(ws, "thread/start", {"cwd": str(scratch), "approvalPolicy": "never", "sandbox": "danger-full-access"}))["thread"]["id"]
                    first = (await request(ws, "turn/start", {"threadId": thread, "input": [{"type": "text", "text": "Reply with exactly READY and then end the turn.", "text_elements": []}]}))["turn"]["id"]
                    print(json.dumps({"event": "first_turn_started", "thread": thread, "turn": first}))
                    await wait_turn(ws, first)
                    queued = (await request(ws, "thread/queue/add", {"threadId": thread, "clientUserMessageId": str(uuid.uuid4()), "input": [{"type": "text", "text": "EVENT: CI completed successfully. Reply with exactly RECEIVED.", "text_elements": []}]}))["queuedSubmission"]["id"]
                    print(json.dumps({"event": "queued_while_idle", "submission": queued}))
                    while True:
                        event = json.loads(await asyncio.wait_for(ws.recv(), 120))
                        report(event)
                        if event.get("method") == "turn/completed":
                            break
                    active = (await request(ws, "turn/start", {"threadId": thread, "input": [{"type": "text", "text": "Run the shell command `sleep 4`, then reply exactly TOOL_DONE. Do not skip the command.", "text_elements": []}]}))["turn"]["id"]
                    print(json.dumps({"event": "active_turn", "turn": active}))
                    await asyncio.sleep(1)
                    mid = (await request(ws, "thread/queue/add", {"threadId": thread, "clientUserMessageId": str(uuid.uuid4()), "input": [{"type": "text", "text": "EVENT DURING TOOL: reply exactly MID_RECEIVED.", "text_elements": []}]}))["queuedSubmission"]["id"]
                    print(json.dumps({"event": "queued_during_active_turn", "submission": mid}))
                    completed = 0
                    while completed < 2:
                        event = json.loads(await asyncio.wait_for(ws.recv(), 120))
                        report(event)
                        if event.get("method") == "turn/completed":
                            completed += 1
                os.chdir(previous_cwd)
            finally:
                server.terminate()  # Only the subprocess started here.
                server.wait(timeout=10)

if __name__ == "__main__":
    asyncio.run(main())
