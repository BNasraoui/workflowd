#!/bin/bash
set -euo pipefail

# A disposable local registry makes the build visible to Dagger's image resolver.
# Nothing is pulled from GHCR or published beyond this machine.
image=${1:-workflowd-agent-base:local}
root=$(mktemp -d)
name="workflowd-agent-image-$$"
cleanup() {
  if [[ $? != 0 ]]; then
    docker logs --tail 60 "$name-engine" >&2 2>/dev/null || true
  fi
  docker rm -fv "$name-engine" "$name-registry" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

curl --proto '=https' --proto-redir '=https' -fsSL https://github.com/dagger/container-use/releases/download/v0.4.2/container-use_v0.4.2_linux_amd64.tar.gz -o "$root/cu.tgz"
echo "3fa52b5833ae4aed2be4b86f7cf42671fdf4bca8c211fe5fff08cc19553d409b  $root/cu.tgz" | sha256sum -c -
tar -xzf "$root/cu.tgz" -C "$root" container-use

docker network create "$name" >/dev/null
docker run -d --name "$name-registry" --memory=128m --memory-swap=128m \
  --network "$name" \
  -p 127.0.0.1::5000 \
  registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 >/dev/null
port=$(docker port "$name-registry" 5000/tcp | cut -d: -f2)
deadline=$((SECONDS + 30))
until curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
  "http://127.0.0.1:$port/v2/" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    printf 'Disposable registry at port %s did not become ready within 30 seconds\n' "$port" >&2
    docker logs --tail 60 "$name-registry" >&2
    exit 1
  fi
  sleep 0.2
done
local_image="localhost:$port/workflowd-agent-base:test"
docker tag "$image" "$local_image"
docker push --quiet "$local_image"
# Lazy image reads can happen in Dagger's inner network, whose DNS does not
# know Docker network aliases. Use the registry's private IP in both contexts.
registry_address=$(docker inspect "$name-registry" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
base="$registry_address:5000/workflowd-agent-base:test"

# Allow HTTP only for the registry on this disposable Docker network.
printf '[registry."%s:5000"]\n  http = true\n' "$registry_address" > "$root/engine.toml"
docker run -d --name "$name-engine" --privileged --network "$name" \
  -v "$root/engine.toml:/etc/dagger/engine.toml:ro" \
  --memory=2g --memory-swap=2g \
  registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36 >/dev/null
export _EXPERIMENTAL_DAGGER_RUNNER_HOST="docker-container://$name-engine"
export HOME="$root/home"
mkdir -p "$HOME" "$root/repository"
git config --global user.name fixture
git config --global user.email fixture@example.invalid
git -C "$root/repository" init -q -b main
printf 'fixture\n' > "$root/repository/README"
(
  cd "$root/repository"
  "$root/container-use" config base-image set "$base"
  git add README .container-use/environment.json
  git commit -qm fixture
)
python3 "$(dirname "$0")/e2e.py" "$root/repository" "$root/container-use"
