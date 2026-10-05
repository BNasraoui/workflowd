#!/bin/bash
set -euo pipefail

[[ $(id -u) == 1000 ]]
[[ $(id -un) == agent ]]
[[ $HOME == /home/agent && -w $HOME && -w /tmp ]]
[[ $LANG == C.UTF-8 && $LC_ALL == C.UTF-8 ]]
[[ -s $SSL_CERT_FILE ]]
[[ ! -w /etc/passwd && ! -w /nix/store ]]
if command -v nix; then
  printf 'Nix must remain a host build dependency\n' >&2
  exit 1
fi

scratch=$(mktemp -d "$HOME/tool-test.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
printf 'agent tools\n' > original
cp original copy
diff original copy
[[ $(find . -name copy) == ./copy ]]
grep -q 'agent' copy
[[ $(sed 's/agent/shared/' copy) == 'shared tools' ]]
[[ $(gawk '{print $2}' copy) == tools ]]
rg -q 'agent' copy
[[ $(fd '^copy$') == copy ]]
bash -c 'test "$BASH_VERSION"'
git init -q
git -c user.name=fixture -c user.email=fixture@example.invalid add original
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture
[[ $(git show HEAD:original) == 'agent tools' ]]
gh --version
curl --fail --silent --show-error https://example.com > page
test -s page
[[ $(printf '{"tool":"jq"}' | jq -r .tool) == jq ]]
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)'
npm init -y > /dev/null
npm pkg get name
bun -e 'if (1 + 1 !== 2) process.exit(1); console.log(Bun.version)'
python3 -c 'import ssl, sys; assert sys.version_info.major == 3; assert ssl.create_default_context().cert_store_stats()["x509_ca"] > 0'
python3 -m venv venv
venv/bin/python -c 'import sys; assert sys.prefix != sys.base_prefix'
rustup --version
[[ $(rustup toolchain list) == 'no installed toolchains' ]]
printf '[toolchain]\nchannel = "1.85.0"\nprofile = "minimal"\n' > rust-toolchain.toml
printf 'fn main() { println!("repository rust toolchain"); }\n' > hello.rs
rustc hello.rs -o rust-hello
[[ $(./rust-hello) == 'repository rust toolchain' ]]
[[ $(rustc --version) == 'rustc 1.85.0 '* ]]
cargo --version
printf '#include <stdio.h>\nint main(void) { puts("native build"); }\n' > hello.c
cc hello.c -o c-hello
[[ $(./c-hello) == 'native build' ]]
# Make expands this variable after the shell writes the file.
# shellcheck disable=SC2016
printf 'all:\n\t$(CC) hello.c -o make-hello\n' > Makefile
make
[[ $(./make-hello) == 'native build' ]]
pkg-config --version
mkdir pc
printf 'Name: fixture\nDescription: native dependency\nVersion: 1.0\nLibs: -lm\n' > pc/fixture.pc
[[ $(PKG_CONFIG_PATH="$scratch/pc" pkg-config --libs fixture) == '-lm' ]]
printf 'ALL_AGENT_TOOLS_PASSED uid=%s\n' "$(id -u)"
