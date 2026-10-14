#!/bin/sh
set -eu
# Build from this reviewed checkout; --build-only validates artifacts without provisioning.
[ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = --build-only ]; } || exit 1
cd "$(dirname "$0")/../.."
command -v bun >/dev/null
bun install --frozen-lockfile --ignore-scripts
mkdir -p dist
bun build --compile src/agent-host/server.ts --outfile dist/workflowd-agent-host
bun build --target=bun src/kernel/codex-worker.ts --outfile dist/workflowd-native-worker.js
bun build --compile deploy/agent-user/relink.ts --outfile dist/workflowd-relink-credentials
bun build --compile deploy/agent-user/migrate-opencode.ts --outfile dist/workflowd-migrate-opencode
[ "${1:-}" != --build-only ] || exit 0
[ "$(id -u)" = 0 ] || { echo 'Root is required' >&2; exit 1; }
# Account/group creation and live cutover belong to the later provisioning phase.
id ben >/dev/null
id workflowd-agent >/dev/null
getent group workflowd-model-auth >/dev/null
for account in ben workflowd-agent; do
  id -nG "$account" | tr ' ' '\n' | grep -qx workflowd-model-auth || exit 1
done
for binary in workflowd-agent-host workflowd-relink-credentials workflowd-migrate-opencode; do
  test -f "dist/$binary"
done
install -d -o root -g root -m 0755 /etc/workflowd /usr/local/libexec /usr/local/sbin
install -d -o root -g workflowd-model-auth -m 0710 \
  /var/lib/workflowd/model-credentials \
  /var/lib/workflowd/model-credentials/codex \
  /var/lib/workflowd/model-credentials/claude
install -d -o root -g root -m 0700 /var/lib/workflowd/agent-host
install -d -o root -g root -m 0711 /var/lib/workflowd/agent-io
install -d -o workflowd-agent -g workflowd-model-auth -m 0700 /var/lib/workflowd-agent/workspaces /var/lib/workflowd-agent/workspaces/agent-runs
install -o root -g root -m 0644 dist/workflowd-native-worker.js /usr/local/libexec/workflowd-native-worker.js
install -o root -g root -m 0755 dist/workflowd-agent-host /usr/local/libexec/workflowd-agent-host
install -o root -g root -m 0755 dist/workflowd-relink-credentials /usr/local/sbin/workflowd-relink-credentials
install -o root -g root -m 0755 dist/workflowd-migrate-opencode /usr/local/sbin/workflowd-migrate-opencode
# Preserve an explicitly reviewed host policy; the checked-in JSON is a template.
test -f /etc/workflowd/agent-host.json || { echo 'Install a reviewed root-owned agent-host.json before enabling admission' >&2; exit 1; }
install -o root -g root -m 0644 deploy/systemd/workflowd-agent-host.service /etc/systemd/system/workflowd-agent-host.service
