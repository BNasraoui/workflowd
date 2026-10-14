#!/bin/bash
set -euo pipefail

# Pinned Linux/amd64 release; no action-owned daemon inherits the step's OIDC env.
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://pkgs.tailscale.com/stable/tailscale_1.94.2_amd64.tgz -o "$directory/tailscale.tgz"
printf '%s  %s\n' c6f99a5d774c7783b56902188d69e9756fc3dddfb08ac6be4cb2585f3fecdc32 \
  "$directory/tailscale.tgz" | sha256sum -c -
tar -xzf "$directory/tailscale.tgz" -C "$directory"
sudo install -m 755 "$directory/tailscale_1.94.2_amd64/"{tailscale,tailscaled} /usr/local/bin/
# systemd owns the daemon and its clean environment, not a background sudo -E.
sudo systemd-run --collect --unit=workflowd-tailscaled \
  /usr/bin/env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL \
  /usr/local/bin/tailscaled --state=mem:
for attempt in $(seq 1 30); do
  if sudo tailscale status --json >/dev/null 2>&1; then break; fi
  sleep 1
done
# Only this short-lived client needs the federated identity token. No token is
# written to disk or emitted in logs. The CLI creates a non-reusable auth key.
python3 - <<'PY'
import json, os, subprocess, urllib.parse, urllib.request
url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=' + urllib.parse.quote(os.environ['SANDBOX_AUDIENCE'], safe='')
request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
with urllib.request.urlopen(request, timeout=30) as response:
    token = json.load(response)['value']
clean = {k: v for k, v in os.environ.items() if not k.startswith('ACTIONS_ID_TOKEN_REQUEST_')}
result = subprocess.run(['sudo', '-n', 'tailscale', 'up', '--timeout=60s', '--ssh',
    '--accept-routes=false', '--accept-dns=false', '--advertise-tags=tag:agent-runner',
    '--hostname=lease-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'],
    '--client-id=' + os.environ['SANDBOX_TAILSCALE_CLIENT_ID'] + '?preauthorized=true&ephemeral=true',
    '--id-token=' + token], env=clean, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if result.returncode:
    raise SystemExit("Tailscale enrollment failed")
PY
# Retain a route inventory in the job log; the live verifier validates it again.
ip route show table 52
