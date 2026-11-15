#!/bin/bash
# The setup that the tests job and the two-UID credential-host job share, one phase per step.
set -euo pipefail
directory=$(cd "$(dirname "$0")/../.." && pwd)
case "${1:-}" in
  clients)
    # The one Claude Code version of the repository; no other step installs Claude Code.
    claude=$(<"$directory/test/resources/claude-code-version")
    [[ "$claude" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    bun add --global --trust @opencode-ai/cli@0.0.0-beta-19242
    printf '5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c  %s\n' "$(command -v opencode2)" | sha256sum --check
    bun add --global --trust @openai/codex@0.159.1 "@anthropic-ai/claude-code@$claude"
    test "$(codex --version)" = 'codex-cli 0.159.1'
    test "$(claude --version)" = "$claude (Claude Code)"
    ;;
  namespaces)
    printf 'WORKFLOWD_AGENT_PROBE_NODE=%s\n' "$(command -v node)" >> "$GITHUB_ENV"
    # This disposable Ubuntu VM must permit systemd's unprivileged namespaces.
    # PrivateUsers and filesystem isolation remain required by the E2E tests.
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    sudo loginctl enable-linger "$USER"
    sudo systemctl start "user@$(id -u).service"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    printf 'XDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
    systemd-run --user --wait --pipe --collect \
      -p PrivateUsers=yes -p PrivateTmp=yes -p ProtectSystem=strict \
      -p ProtectHome=tmpfs -p NoNewPrivileges=yes \
      -p MemoryMax=256M -p MemorySwapMax=0 /usr/bin/true
    ;;
  identities)
    sudo groupadd --gid 61000 workflowd-model-auth
    sudo useradd --uid 61001 --gid 61000 --no-create-home --shell /usr/sbin/nologin ben-fixture
    sudo useradd --uid 61002 --gid 61000 --no-create-home --shell /usr/sbin/nologin agent-fixture
    # Fixture children import reviewed source as their real UID. Grant only
    # read/traverse access to the disposable checkout, preserving private homes.
    path="$PWD"
    while [ "$path" != / ]; do
      sudo setfacl -m u:61001:--x,u:61002:--x "$path"
      path=$(dirname "$path")
    done
    sudo setfacl -R -m u:61001:rX,u:61002:rX "$PWD"
    sudo mkdir -p /opt/workflowd-credential-fixture/bin
    sudo cp -rf "$HOME/.bun/install/global/node_modules" /opt/workflowd-credential-fixture/
    sudo chown -R root:root /opt/workflowd-credential-fixture
    sudo chmod -R go-w /opt/workflowd-credential-fixture
    sudo install -m 0755 "$(command -v bun)" /opt/workflowd-credential-fixture/bin/bun
    sudo install -m 0755 "$(command -v node)" /opt/workflowd-credential-fixture/bin/node
    for client in codex claude opencode2; do
      source=$(readlink -f "$(command -v "$client")")
      relative=${source#"$HOME/.bun/install/global/"}
      test "$relative" != "$source"
      sudo ln -s "/opt/workflowd-credential-fixture/$relative" "/opt/workflowd-credential-fixture/bin/$client"
    done
    ;;
  *) exit 1 ;;
esac
