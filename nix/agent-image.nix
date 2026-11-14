{ pkgs }:
let
  skills = import ./agent-skills.nix { inherit pkgs; };
  claudeBinary = pkgs.fetchurl {
    url = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.301/linux-x64/claude";
    hash = "sha256-vBqtmYLHtZx9iJ/5JZXWHPRuCm6uB0y1UdkyqYm80iI=";
  };
  codexArchive = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@openai/codex/-/codex-0.159.1-linux-x64.tgz";
    sha256 = "9d6476abf421afe566c7afade3bb3c4aa1586c6f673c6a9e346b625e6b19561f";
  };
  openCodeArchive = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@opencode-ai/cli-linux-x64/-/cli-linux-x64-0.0.0-beta-19242.tgz";
    sha256 = "72fda4bcc37d1ceb4d743d5d00e793a0b3a9f52452daea41f09fcf49f65d6e94";
  };
  native = pkgs.runCommand "workflowd-native-claude-2.1.301" {} ''
    mkdir -p $out/bin $out/opt/workflowd
    cp ${claudeBinary} $out/bin/claude
    chmod 0555 $out/bin/claude
    cp ${../deploy/sandbox/claude-interactive.py} $out/opt/workflowd/claude-interactive.py
    cp ${../deploy/sandbox/native-client.py} $out/opt/workflowd/native-client.py
    ${pkgs.gnutar}/bin/tar -xOf ${codexArchive} package/vendor/x86_64-unknown-linux-musl/bin/codex > $out/bin/codex
    ${pkgs.gnutar}/bin/tar -xOf ${openCodeArchive} package/bin/opencode2 > $out/bin/opencode2
    chmod 0555 $out/bin/codex $out/bin/opencode2
  '';
  tools = pkgs.buildEnv {
    name = "agent-tools";
    paths = with pkgs; [
      bashInteractive coreutils findutils gnugrep gnused gawk diffutils
      gnutar gzip xz unzip which procps openssh less
      git gh curl cacert jq ripgrep fd nodejs_24 bun
      (python3.withPackages (ps: [ ps.pip ])) rustup
      gcc gnumake binutils pkg-config
    ];
    pathsToLink = [ "/bin" ];
  };
in
pkgs.dockerTools.streamLayeredImage {
  name = "workflowd-agent-base";
  tag = "local";
  created = "1970-01-01T00:00:01Z";
  contents = [ tools pkgs.nix-ld skills native ];
  # Keep native Dagger snapshotters from copying a long chain of tiny layers.
  maxLayers = 20;
  extraCommands = ''
    mkdir -p etc bin usr/bin lib64 home/agent workdir tmp
    printf 'root:x:0:0:root:/root:/bin/bash\nagent:x:1000:1000:Agent:/home/agent:/bin/bash\n' > etc/passwd
    printf 'root:x:0:\nagent:x:1000:\n' > etc/group
    printf 'hosts: files dns\n' > etc/nsswitch.conf
    printf '/bin/sh\n/bin/bash\n' > etc/shells
    ln -s ${pkgs.coreutils}/bin/env usr/bin/env
    # rustup downloads upstream ELF binaries with the conventional loader path.
    ln -s ${pkgs.nix-ld}/libexec/nix-ld lib64/ld-linux-x86-64.so.2
    chmod 1777 tmp
  '';
  fakeRootCommands = ''
    chown 1000:1000 home/agent workdir
  '';
  config = {
    User = "1000:1000";
    WorkingDir = "/workdir";
    Cmd = [ "/bin/bash" ];
    Env = [
      "HOME=/home/agent"
      "USER=agent"
      "PATH=/home/agent/.cargo/bin:/bin:/usr/bin"
      "LANG=C.UTF-8"
      "LC_ALL=C.UTF-8"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "RUSTUP_HOME=/home/agent/.rustup"
      "CARGO_HOME=/home/agent/.cargo"
      "NIX_LD=${pkgs.stdenv.cc.bintools.dynamicLinker}"
      "NIX_LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.zlib ]}"
    ];
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/BNasraoui/workflowd";
      "org.opencontainers.image.description" = "General tools for non-root workflowd agent sandboxes";
    };
  };
}
