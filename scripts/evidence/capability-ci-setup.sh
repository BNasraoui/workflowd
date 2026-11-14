#!/bin/bash
# Invoked only behind public-output.mjs; raw setup diagnostics stay private.
set -euo pipefail
umask 077
case "$1" in
  dependencies)
    bun install --frozen-lockfile --ignore-scripts
    ;;
  namespace)
    sudo apt-get update -qq
    sudo apt-get install -y bubblewrap openssh-server iproute2
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    sudo loginctl enable-linger "$USER"
    sudo systemctl start "user@$(id -u).service"
    ;;
  tools)
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    tools="$RUNNER_TEMP/capability-tools"
    mkdir -p "$tools/bin"
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
      git -c credential.helper= -c http.extraHeader= fetch --no-tags origin f74e0505155bc32aa2cedef00ba8b08ef1b90007
    systemd-run --user --wait --pipe --collect -p MemoryMax=6G -p MemorySwapMax=0 \
      -p CPUQuota=200% -p TasksMax=512 -p RuntimeMaxSec=300 \
      --setenv="PATH=$PATH" cargo install --locked --root "$tools" \
      --git https://github.com/BNasraoui/noscope.git --rev 0e87a571de0c76c83af7c46e767c0d5b650a7886
    curl -fsSL --proto '=https' --tlsv1.2 https://registry.npmjs.org/@openai/codex/-/codex-0.159.1-linux-x64.tgz -o "$tools/codex.tgz"
    curl -fsSL --proto '=https' --tlsv1.2 https://registry.npmjs.org/@opencode-ai/cli-linux-x64/-/cli-linux-x64-0.0.0-beta-19242.tgz -o "$tools/opencode.tgz"
    curl -fsSL --proto '=https' --tlsv1.2 https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.301/linux-x64/claude -o "$tools/bin/claude"
    printf '%s  %s\n' 9d6476abf421afe566c7afade3bb3c4aa1586c6f673c6a9e346b625e6b19561f "$tools/codex.tgz" 72fda4bcc37d1ceb4d743d5d00e793a0b3a9f52452daea41f09fcf49f65d6e94 "$tools/opencode.tgz" bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222 "$tools/bin/claude" | sha256sum --check --status
    tar -xOf "$tools/codex.tgz" package/vendor/x86_64-unknown-linux-musl/bin/codex > "$tools/bin/codex"
    tar -xOf "$tools/opencode.tgz" package/bin/opencode2 > "$tools/bin/opencode2"
    chmod 0555 "$tools/bin/claude" "$tools/bin/codex" "$tools/bin/opencode2"
    ;;
  *) exit 1 ;;
esac
