{ pkgs }:
let
  tools = pkgs.buildEnv {
    name = "agent-tools";
    paths = with pkgs; [
      bashInteractive coreutils findutils gnugrep gnused gawk diffutils
      gnutar gzip xz unzip which procps openssh less
      git gh curl cacert jq ripgrep fd nodejs_24 bun
      (python3.withPackages (ps: [ ps.pip ])) rustup nix-ld
      gcc gnumake binutils pkg-config
    ];
    pathsToLink = [ "/bin" ];
  };
in
pkgs.dockerTools.streamLayeredImage {
  name = "workflowd-agent-base";
  tag = "local";
  created = "1970-01-01T00:00:01Z";
  contents = [ tools ];
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
