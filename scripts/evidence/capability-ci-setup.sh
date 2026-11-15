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
    sudo apt-get install -y bubblewrap iproute2
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
    ;;
  *) exit 1 ;;
esac
