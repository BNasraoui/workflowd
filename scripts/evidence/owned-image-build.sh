#!/bin/sh
set -eu
umask 077
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
test ! -S /var/run/docker.sock
trap 'chown -R "$FIXTURE_UID:$FIXTURE_GID" /evidence' EXIT
export HOME=/tmp/build-home
mkdir -p "$HOME"
nix --version > /evidence/nix-version
nix build --extra-experimental-features 'nix-command flakes' \
  --option sandbox false --option build-users-group '' --option max-jobs 2 --option cores 2 \
  --no-write-lock-file --no-link --print-out-paths path:/source/build#agent-image \
  > /evidence/image-builder-path 2> /evidence/nix-build.log
builder=$(cat /evidence/image-builder-path)
"$builder" > /evidence/agent-image.tar 2> /evidence/image-stream.log
sha256sum /evidence/agent-image.tar > /evidence/image-sha256
touch /evidence/build-completed
