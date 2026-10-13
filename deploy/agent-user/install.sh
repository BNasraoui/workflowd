#!/bin/sh
set -eu
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
install -o root -g root -m 0755 dist/workflowd-agent-host /usr/local/libexec/workflowd-agent-host
install -o root -g root -m 0755 dist/workflowd-relink-credentials /usr/local/sbin/workflowd-relink-credentials
install -o root -g root -m 0755 dist/workflowd-migrate-opencode /usr/local/sbin/workflowd-migrate-opencode
# Preserve an explicitly reviewed host policy; the checked-in JSON is a template.
test -f /etc/workflowd/agent-host.json || { echo 'Install a reviewed root-owned agent-host.json before enabling admission' >&2; exit 1; }
install -o root -g root -m 0644 deploy/systemd/workflowd-agent-host.service /etc/systemd/system/workflowd-agent-host.service
