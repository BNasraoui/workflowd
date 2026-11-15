#!/bin/bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
if [[ ${WORKFLOWD_TEST_RESOURCE_SHELL:-} != 1 ]]; then
  exec bun "$repository_root/test/resources/run.ts" bash "$0" "$@"
fi

# The image before it runs. test/gateway-image/drive.ts then runs it against the session fixtures.
image=${1:-workflowd-gateway:local}
root=$(mktemp -d)
name="workflowd-gateway-image-$$"
cleanup() {
  docker rm -fv "$name" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

# The image runs as its own non-root user with the gateway as its command.
[[ $(docker image inspect --format '{{.Config.User}}' "$image") == 10001:10001 ]]
[[ $(docker image inspect --format '{{json .Config.Entrypoint}}' "$image") == '["/bin/bun","/app/src/capability-gateway-server.ts"]' ]]

# The image holds no login and no key: no credential file by name, no private key or provider
# token by content, and an empty home for the gateway.
docker create --name "$name" "$image" >/dev/null
docker export "$name" > "$root/image.tar"
docker rm -v "$name" >/dev/null
mkdir "$root/fs"
tar -xf "$root/image.tar" -C "$root/fs" --no-same-owner --no-same-permissions
chmod -R u+rwX "$root/fs"
if find "$root/fs" -regextype posix-extended -iregex \
  '.*/(\.credentials\.json|\.git-credentials|\.netrc|\.npmrc|auth\.json|id_(rsa|ecdsa|ed25519)|[^/]*\.(key|p12|pfx)|\.ssh|\.claude|\.config/(gh|noscope)|providers/[^/]*\.toml)' \
  -print | grep .; then
  echo "credential-like path in the image" >&2
  exit 1
fi
if grep -rlE 'sk-ant-[A-Za-z0-9_-]{20}|gh[opsu]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20}' "$root/fs"; then
  echo "provider or GitHub token in the image" >&2
  exit 1
fi
# Public npm packages carry PEM parsers and test keys. Their files are those of bun.lock's
# integrity hashes, fixed again by the output hash of nix/workflowd-modules.nix.
if grep -rlE 'BEGIN ([A-Z]+ )?PRIVATE KEY' --exclude-dir='*-workflowd-node-modules' "$root/fs"; then
  echo "private key in the image" >&2
  exit 1
fi
[[ -z $(ls -A "$root/fs/var/lib/workflowd-gateway") ]]
echo "gateway image: user, entrypoint and contents passed"
