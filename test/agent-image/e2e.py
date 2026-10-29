"""Exercise the real container-use MCP server and its Dagger engine."""

import json
import pathlib
import shlex
import subprocess
import sys

repository = pathlib.Path(sys.argv[1]).resolve()
probe = pathlib.Path(__file__).with_name("tools.sh").read_text()
server = subprocess.Popen(
    [sys.argv[2], "stdio"],
    cwd=repository,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)
request_id = 0


def request(method, params):
    global request_id
    request_id += 1
    print("container-use: " + method, flush=True)
    server.stdin.write(json.dumps({
        "jsonrpc": "2.0", "id": request_id, "method": method, "params": params
    }) + "\n")
    server.stdin.flush()
    response = json.loads(server.stdout.readline())
    assert response["id"] == request_id, response
    assert "error" not in response, response
    result = response["result"]
    assert not result.get("isError"), result
    return result


try:
    request("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "workflowd-image-e2e", "version": "1"},
    })
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    server.stdin.flush()
    catalog = request("tools/list", {})
    assert any(tool["name"] == "environment_create" for tool in catalog["tools"])
    created = request("tools/call", {
        "name": "environment_create",
        "arguments": {"environment_source": str(repository), "title": "Base image proof"},
    })
    environment_id = json.loads(created["content"][0]["text"])["id"]
    result = request("tools/call", {
        "name": "environment_run_cmd",
        "arguments": {
            "environment_source": str(repository),
            "environment_id": environment_id,
            "command": "bash -euo pipefail -c " + shlex.quote(probe),
        },
    })
    output = "\n".join(item["text"] for item in result["content"])
    print(output)
    assert "ALL_AGENT_TOOLS_PASSED uid=1000" in output, output
    refs = subprocess.check_output(
        ["git", "for-each-ref", "--format=%(refname)"], cwd=repository, text=True
    )
    assert "container-use/" + environment_id in refs, refs
    assert (repository / "README").read_text() == "fixture\n"
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
