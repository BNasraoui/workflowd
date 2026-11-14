#!/bin/sh
# Only inside the verified disposable controller or an offline image build.
set -eu
mirror=${WORKFLOWD_LEGACY_MIRROR:-/opt/workflowd-offline/apt-inputs}
test -f "$mirror/ubuntu-archive.gpg"
directory=$(mktemp -d /tmp/workflowd-apt.XXXXXX)
mkdir -p "$directory/etc/apt.conf.d" "$directory/lists/partial" "$directory/cache/archives/partial"
printf 'Dir::Etc "%s/etc";\nDir::Etc::parts "apt.conf.d";\nDir::Etc::main "empty";\n' "$directory" > "$directory/apt.conf"
for suite in noble noble-updates noble-security; do
  printf 'deb [arch=amd64 signed-by=%s/ubuntu-archive.gpg] file:%s %s main\n' "$mirror" "$mirror" "$suite"
done > "$directory/sources.list"
export APT_CONFIG="$directory/apt.conf" DEBIAN_FRONTEND=noninteractive
apt-get -o "Dir::Etc::sourcelist=$directory/sources.list" -o Dir::Etc::sourceparts=- \
  -o "Dir::State::lists=$directory/lists" -o "Dir::Cache=$directory/cache" \
  -o Acquire::Languages=none update
apt-get -y --no-install-recommends -o "Dir::Etc::sourcelist=$directory/sources.list" \
  -o Dir::Etc::sourceparts=- -o "Dir::State::lists=$directory/lists" \
  -o "Dir::Cache=$directory/cache" install "$@"
rm -rf "$directory"
