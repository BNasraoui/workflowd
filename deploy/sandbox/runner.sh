#!/bin/bash
set -euo pipefail

# Only bounded control and audit data reaches Actions artifacts/logs.
# Task output stays on the SSH/container-use stream.
boot() {
  local image_id
  image_id=$(DOCKER_BUILDKIT=0 docker build --quiet --memory=512m --memory-swap=512m \
    -f "$(dirname "$0")/Containerfile" "$(dirname "$0")")
  docker network create workflowd-sandbox >/dev/null
  docker run -d --name workflowd-sandbox-engine --network workflowd-sandbox \
    --network-alias engine --privileged --memory=4g --memory-swap=4g \
    registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36 \
    --addr tcp://0.0.0.0:1234 >/dev/null
  docker run -d --name workflowd-sandbox-tooling --network workflowd-sandbox \
    --memory=2g --memory-swap=2g "$image_id" >/dev/null
}

clone_source() {
  local repository="$1" source_sha="$2"
  docker exec workflowd-sandbox-tooling git init -b sandbox
  docker exec workflowd-sandbox-tooling git remote add origin "https://github.com/$repository.git"
  docker exec workflowd-sandbox-tooling git -c credential.helper= fetch origin "$source_sha"
  docker exec workflowd-sandbox-tooling git checkout --detach "$source_sha"
}

case "${1:-}" in
  start)
    repository="${2:?repository required}"
    source_sha="${3:?source SHA required}"
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
    [[ "$source_sha" =~ ^[a-f0-9]{40}$ ]]
    boot
    clone_source "$repository" "$source_sha"
    ;;
  prepare)
    # This runs before the agent is given any connection. No model/App secrets
    # enter the runner. The GitHub-issued OIDC token is never saved or printed.
    sudo install -d -o runner -g runner -m 700 /run/workflowd-sandbox
    python3 - <<'PY'
import base64, json, os, re, subprocess, urllib.parse, urllib.request
from pathlib import Path
root = Path('/run/workflowd-sandbox')
ref = os.environ['GITHUB_REF']
lease = ref.removeprefix('refs/heads/workflowd/leases/')
assert re.fullmatch('[a-zA-Z0-9-]{1,80}', lease)
aud = os.environ['SANDBOX_AUDIENCE']
url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=' + urllib.parse.quote(aud, safe='')
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
with urllib.request.urlopen(req, timeout=30) as response:
    token = json.load(response)['value']
encoded = token.split('.')[1]
claims = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
expected = {
    'aud': aud, 'repository': os.environ['GITHUB_REPOSITORY'],
    'repository_id': os.environ['GITHUB_REPOSITORY_ID'],
    'repository_owner_id': os.environ['GITHUB_REPOSITORY_OWNER_ID'],
    'actor_id': os.environ['GITHUB_ACTOR_ID'], 'event_name': 'push',
    'ref': ref, 'sha': os.environ['GITHUB_SHA'],
    'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
    'job_workflow_sha': os.environ.get('SANDBOX_TOOLING_SHA', os.environ['GITHUB_SHA']), 'runner_environment': 'github-hosted',
}
assert all(claims.get(key) == value for key, value in expected.items()), 'OIDC claim mismatch'
expected_sub = 'repo:' + os.environ['GITHUB_REPOSITORY_OWNER'] + '@' + os.environ['GITHUB_REPOSITORY_OWNER_ID'] + '/' + os.environ['GITHUB_REPOSITORY'].split('/')[1] + '@' + os.environ['GITHUB_REPOSITORY_ID'] + ':ref:' + ref
assert claims['sub'] == expected_sub, 'Immutable OIDC subject mismatch'
peer = json.loads(subprocess.check_output(['tailscale', 'status', '--json']))['Self']
ready = {'leaseId': lease, 'repository': expected['repository'], 'repositoryId': int(expected['repository_id']),
         'workflowSha': expected['sha'], 'appActorId': int(expected['actor_id']),
         'runId': int(expected['run_id']), 'attempt': int(expected['run_attempt']),
         'peerId': peer['ID'], 'address': next(ip for ip in peer['TailscaleIPs'] if ':' not in ip),
         'claims': {**expected, 'sub': claims['sub'], 'job_workflow_ref': claims['job_workflow_ref']}}
(root / 'identity.json').write_text(json.dumps(ready))
PY
    # Suppress setup output: only the fixed metadata artifact is published.
    boot >/run/workflowd-sandbox/setup.log 2>&1
    sudo install -m 755 "$0" /usr/local/bin/container-use
    sudo install -m 755 "$0" /usr/local/bin/runner-control
    cp -f /run/workflowd-sandbox/identity.json /run/workflowd-sandbox/ready.json
    ;;
  initialize)
    request=$(python3 -c '
import json, re, sys
from pathlib import Path
try:
    data = sys.stdin.read(4097)
    assert len(data) <= 4096
    request = json.loads(data)
    assert set(request) == {"repository", "sourceSha"}
    assert re.fullmatch("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", request["repository"])
    assert re.fullmatch("[a-f0-9]{40}", request["sourceSha"])
    identity = json.loads(Path("/run/workflowd-sandbox/identity.json").read_text())
    assert request["repository"] == identity["repository"]
    print(request["repository"], request["sourceSha"])
except (ValueError, KeyError, AssertionError, TypeError, OSError):
    sys.exit("Invalid sandbox source request")
')
    read -r repository source_sha <<<"$request"
    exec 9>/run/workflowd-sandbox/source.lock
    flock -x 9
    if [[ -f /run/workflowd-sandbox/source.sha ]]; then
      [[ "$(cat /run/workflowd-sandbox/source.sha)" == "$source_sha" ]]
    else
      timeout 300 bash -c 'set -euo pipefail; docker exec workflowd-sandbox-tooling git init -b sandbox; docker exec workflowd-sandbox-tooling git remote add origin "https://github.com/$1.git"; docker exec workflowd-sandbox-tooling git -c credential.helper= fetch origin "$2"; docker exec workflowd-sandbox-tooling git checkout --detach "$2"' _ "$repository" "$source_sha" >/run/workflowd-sandbox/clone.log 2>&1
      printf '%s\n' "$source_sha" > /run/workflowd-sandbox/source.sha
    fi
    printf '%s\n' "$source_sha"
    ;;
  finish-result)
    source_sha=$(cat /run/workflowd-sandbox/source.sha)
    docker exec -i workflowd-sandbox-tooling python3 /usr/local/lib/workflowd-result.py seal \
      /workspace/repository /tmp/workflowd-result "$source_sha" > /run/workflowd-sandbox/result-metadata.json
    if ! python3 -c 'import json,sys; sys.exit(0 if json.load(open("/run/workflowd-sandbox/result-metadata.json")).get("empty") else 1)'; then
      mkdir -p /run/workflowd-sandbox/result
      docker cp workflowd-sandbox-tooling:/tmp/workflowd-result/. /run/workflowd-sandbox/result/ >/dev/null
    fi
    cat /run/workflowd-sandbox/result-metadata.json
    ;;
  finish)
    test -s /run/workflowd-sandbox/result/result.json
    test -s /run/workflowd-sandbox/result/result.bundle
    touch /run/workflowd-sandbox/finished
    ;;
  heartbeat)
    date +%s > /run/workflowd-sandbox/heartbeat
    ;;
  audit|hold)
    # The hold process owns Actions stdout. SSH only queues data and reads receipts.
    python3 -c '
import fcntl, json, os, sys, time
from pathlib import Path
root = Path("/run/workflowd-sandbox")
mode = sys.argv[1]
limit = 4096
capacity = 1024
path = root / "audit.json"
lock = root / "audit.lock"
def state():
    if not path.exists(): return {"records": {}, "emittedThrough": 0}
    if path.stat().st_size > limit * capacity: raise ValueError("audit capacity")
    return json.loads(path.read_text())
def save(data):
    temporary = root / "audit.tmp"
    encoded = json.dumps(data, ensure_ascii=True, separators=(",", ":"))
    assert len(encoded) <= limit * capacity
    temporary.write_text(encoded)
    temporary.replace(path)
def validate(record):
    assert set(record) == {"runId", "leaseId", "sequence", "callId", "tool", "command", "commandSha256", "exitCode", "outcome", "complete"}
    assert all(isinstance(record[k], str) and len(record[k]) <= 512 for k in ["runId", "leaseId", "callId", "tool"])
    assert type(record["sequence"]) is int and 1 <= record["sequence"] <= capacity
    assert record["command"] is None or isinstance(record["command"], str) and len(record["command"]) <= 512
    assert record["commandSha256"] is None or isinstance(record["commandSha256"], str) and len(record["commandSha256"]) == 64
    assert record["exitCode"] is None or type(record["exitCode"]) is int and 0 <= record["exitCode"] <= 255
    assert record["outcome"] in ["ok", "error", "unknown"] and type(record["complete"]) is bool
    assert len(json.dumps(record, ensure_ascii=True)) <= limit
    identity = root / "identity.json"
    if identity.exists():
        expected = json.loads(identity.read_text()).get("leaseId")
        assert expected is None or record["leaseId"] == expected
if mode == "audit":
    raw = sys.stdin.buffer.read(limit + 1)
    assert len(raw) <= limit
    record = json.loads(raw)
    validate(record)
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        data = state()
        key = str(record["sequence"])
        previous = data["records"].get(key)
        assert previous is None or previous == record
        if data["records"]:
            owner = next(iter(data["records"].values()))
            assert (owner["runId"], owner["leaseId"]) == (record["runId"], record["leaseId"])
        data["records"][key] = record
        save(data)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with lock.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_SH)
            receipt = state()["emittedThrough"]
        if receipt >= record["sequence"]:
            print(json.dumps({"emittedThrough": receipt}), flush=True)
            break
        time.sleep(0.05)
    else: sys.exit("Sandbox audit emission unconfirmed")
else:
    heartbeat = root / "heartbeat"
    heartbeat.write_text(str(int(time.time())))
    while time.time() - int(heartbeat.read_text()) < 120:
        if (root / "finished").exists(): break
        with lock.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            data = state()
            changed = False
            while str(data["emittedThrough"] + 1) in data["records"]:
                record = data["records"][str(data["emittedThrough"] + 1)]
                validate(record)
                print("workflowd.audit " + json.dumps(record, ensure_ascii=True, separators=(",", ":")), flush=True)
                data["emittedThrough"] += 1
                changed = True
            if changed: save(data)
        time.sleep(0.05)
' "$1"
    ;;
  stdio)
    exec docker exec -i workflowd-sandbox-tooling \
      env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner \
      _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://engine:1234 \
      /usr/local/bin/container-use stdio
    ;;
  stop)
    for container in workflowd-sandbox-tooling workflowd-sandbox-engine; do
      if docker container inspect "$container" >/dev/null 2>&1; then
        docker rm -f "$container" >/dev/null
      fi
    done
    if docker network inspect workflowd-sandbox >/dev/null 2>&1; then
      docker network rm workflowd-sandbox >/dev/null
    fi
    ;;
  *)
    printf 'Unknown sandbox operation\n' >&2
    exit 2
    ;;
esac
