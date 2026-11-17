#!/bin/bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
if [[ ${WORKFLOWD_TEST_RESOURCE_SHELL:-} != 1 ]]; then
  exec bun "$repository_root/test/resources/run.ts" bash "$0" "$@"
fi

# The image before it runs. test/gateway-image/drive.ts then runs it against the session fixtures.
image=workflowd-gateway:local
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
# A scan that cannot read the whole image fails the test as a match does: find exits above 0 on
# an error, and grep exits 0 on a match, 1 on none and above 1 on an error.
status=0
find "$root/fs" -regextype posix-extended -iregex \
  '.*/(\.credentials\.json|\.git-credentials|\.netrc|\.npmrc|auth\.json|id_(rsa|ecdsa|ed25519)|[^/]*\.(key|p12|pfx)|\.ssh|\.claude|\.config/(gh|noscope)|providers/[^/]*\.toml)' \
  -print > "$root/paths" || status=$?
paths=no
if ((status != 0)); then
  paths=error
elif [[ -s $root/paths ]]; then
  cat "$root/paths" >&2
  paths=match
fi
# Public npm packages carry PEM parsers, test keys and example tokens. Their files are those of
# bun.lock's integrity hashes, fixed again by the output hash of nix/workflowd-modules.nix.
status=0
grep -rlE 'BEGIN ([A-Z]+ )?PRIVATE KEY|sk-ant-[A-Za-z0-9_-]{20}|gh[opsu]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20}' \
  --exclude-dir='*-workflowd-node-modules' "$root/fs" >&2 || status=$?
contents=no
if ((status == 0)); then contents=match; elif ((status > 1)); then contents=error; fi
if [[ $paths != no || $contents != no ]]; then
  echo "credential-like path: $paths; key or token material: $contents" >&2
  exit 1
fi
[[ $(ls -A "$root"/fs/nix/store/*-workflowd-node-modules) == node_modules ]]
[[ -z $(ls -A "$root/fs/var/lib/workflowd-gateway") ]]
echo "gateway image: user, entrypoint and contents passed"

# The gateway's system unit, with the commands of its unit file, on this image.
bash "$repository_root/test/gateway-image/unit.sh"
