#!/bin/bash
set -euo pipefail

# Only fixed control data leaves this process through Actions artifacts/logs.
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
    'job_workflow_sha': os.environ['GITHUB_SHA'], 'runner_environment': 'github-hosted',
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
  heartbeat)
    date +%s > /run/workflowd-sandbox/heartbeat
    ;;
  hold)
    date +%s > /run/workflowd-sandbox/heartbeat
    while (( $(date +%s) - $(cat /run/workflowd-sandbox/heartbeat) < 120 )); do
      sleep 5
    done
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
