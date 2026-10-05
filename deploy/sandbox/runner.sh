#!/bin/bash
set -euo pipefail

# One disposable runner owns one lease. This file is installed as container-use
# on the runner host; the actual pinned binary lives in the tooling container.
case "${1:-}" in
  start)
    repository="${2:?repository required}"
    source_sha="${3:?source SHA required}"
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
    [[ "$source_sha" =~ ^[a-f0-9]{40}$ ]]
    image_id=$(docker build --quiet -f "$(dirname "$0")/Containerfile" "$(dirname "$0")")
    docker network create workflowd-sandbox >/dev/null
    docker run -d --name workflowd-sandbox-engine --network workflowd-sandbox \
      --network-alias engine --privileged \
      registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36 \
      --addr tcp://0.0.0.0:1234 >/dev/null
    docker run -d --name workflowd-sandbox-tooling --network workflowd-sandbox "$image_id" >/dev/null
    docker exec workflowd-sandbox-tooling git init -b sandbox
    docker exec workflowd-sandbox-tooling git remote add origin "https://github.com/$repository.git"
    docker exec workflowd-sandbox-tooling git -c credential.helper= fetch --depth=1 origin "$source_sha"
    docker exec workflowd-sandbox-tooling git checkout --detach "$source_sha"
    ;;
  stdio)
    exec docker exec -i workflowd-sandbox-tooling \
      env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
      _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://engine:1234 \
      /usr/local/bin/container-use stdio
    ;;
  stop)
    docker rm -f workflowd-sandbox-tooling workflowd-sandbox-engine >/dev/null
    docker network rm workflowd-sandbox >/dev/null
    ;;
  *)
    printf 'Expected start, stdio, or stop\n' >&2
    exit 2
    ;;
esac
