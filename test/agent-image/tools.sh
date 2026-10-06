#!/bin/bash
set -euo pipefail

[[ $(id -u) == 1000 ]]
[[ $(id -un) == agent ]]
[[ $HOME == /home/agent && -w $HOME && -w /tmp ]]
[[ $LANG == C.UTF-8 && $LC_ALL == C.UTF-8 ]]
[[ -s $SSL_CERT_FILE ]]
[[ ! -w /etc/passwd && ! -w /nix/store ]]
[[ ! ${LD_LIBRARY_PATH+x} ]]
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
tar -cf tools.tar original
[[ $(tar -xOf tools.tar original) == 'agent tools' ]]
gzip -c original > original.gz
[[ $(gzip -dc original.gz) == 'agent tools' ]]
xz -c original > original.xz
[[ $(xz -dc original.xz) == 'agent tools' ]]
python3 -c 'import zipfile; zipfile.ZipFile("tools.zip", "w").write("original")'
[[ $(unzip -p tools.zip original) == 'agent tools' ]]
[[ $(which bash) == /bin/bash ]]
[[ $(ps -o uid= -p $$ | tr -d ' ') == 1000 ]]
ssh -V
ssh-keygen -q -t ed25519 -N '' -f fixture-key
ssh-keygen -lf fixture-key.pub
[[ $(LESSSECURE=1 less -F original) == 'agent tools' ]]
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
curl --proto '=https' --fail --silent --show-error https://example.com > page
[[ -s page ]]
[[ $(printf '{"tool":"jq"}' | jq -r .tool) == jq ]]
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)'
npm init -y > /dev/null
npm pkg get name
bun -e 'if (1 + 1 !== 2) process.exit(1); console.log(Bun.version)'
python3 -c 'import ssl, sys; assert sys.version_info.major == 3; assert ssl.create_default_context().cert_store_stats()["x509_ca"] > 0'
python3 -m pip --version
pip --version
python3 -m venv venv
venv/bin/python -c 'import sys; assert sys.prefix != sys.base_prefix'
venv/bin/python -m pip --version
# Install a tiny local package without relying on PyPI or the system site-packages.
python3 - <<'PY'
import zipfile

with zipfile.ZipFile("fixture-1.0-py3-none-any.whl", "w") as wheel:
    wheel.writestr("fixture.py", "value = 'agent pip'\n")
    wheel.writestr("fixture-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: fixture\nVersion: 1.0\n")
    wheel.writestr("fixture-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
    wheel.writestr("fixture-1.0.dist-info/RECORD", "")
PY
python3 -m pip install --no-index --no-deps --target "$scratch/site" fixture-1.0-py3-none-any.whl
PYTHONPATH="$scratch/site" python3 -c 'import fixture; assert fixture.value == "agent pip"'
rustup --version
[[ $(rustup toolchain list) == 'no installed toolchains' ]]
printf '[toolchain]\nchannel = "1.85.0"\nprofile = "minimal"\n' > rust-toolchain.toml
cargo init --bin --name rust-hello rust-project
printf 'fn main() { println!("repository rust toolchain"); assert!(std::env::var_os("LD_LIBRARY_PATH").is_none()); }\n' > rust-project/src/main.rs
cargo build --offline --manifest-path rust-project/Cargo.toml
[[ $(./rust-project/target/debug/rust-hello) == 'repository rust toolchain' ]]
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
