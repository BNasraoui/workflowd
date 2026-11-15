{ pkgs }:
let
  bun = import ./bun.nix { inherit pkgs; };
  noscope = import ./noscope.nix { inherit pkgs; };
  modules = import ./workflowd-modules.nix { inherit pkgs bun; };
  source = pkgs.lib.fileset.toSource {
    root = ../.;
    fileset = pkgs.lib.fileset.unions [
      ../src
      ../package.json
      ../tsconfig.json
      # The files of deploy/ that src imports.
      ../deploy/opencode/sandbox.json
      ../deploy/sandbox/publication.mjs
      ../deploy/sandbox/casefold.json
      ../deploy/sandbox/publication-unicode.json
      ../deploy/sandbox/public-status.mjs
      ../deploy/sandbox/skills/catalog.json
    ];
  };
  # The gateway's source beside its modules. Bun resolves each package from its real path, so
  # node_modules stays one directory of the modules output.
  app = pkgs.runCommand "workflowd-gateway-app" { } ''
    mkdir $out
    cp -r ${source}/src ${source}/deploy ${source}/package.json ${source}/tsconfig.json $out/
    ln -s ${modules}/node_modules $out/node_modules
  '';
  home = "/var/lib/workflowd-gateway";
in
{
  inherit bun noscope modules app;
  image = pkgs.dockerTools.streamLayeredImage {
    name = "workflowd-gateway";
    tag = "local";
    created = "1970-01-01T00:00:01Z";
    contents = [ bun noscope ];
    extraCommands = ''
      mkdir -p etc tmp var/lib/workflowd-gateway
      ln -s ${app} app
      printf 'root:x:0:0:root:/nonexistent:/bin/false\ngateway:x:10001:10001:Gateway:${home}:/bin/false\n' > etc/passwd
      printf 'root:x:0:\ngateway:x:10001:\n' > etc/group
      printf 'hosts: files dns\n' > etc/nsswitch.conf
      chmod 1777 tmp
      date +%s%N > etc/build-stamp
    '';
    fakeRootCommands = ''
      chown 10001:10001 var/lib/workflowd-gateway
      chmod 0700 var/lib/workflowd-gateway
    '';
    config = {
      User = "10001:10001";
      WorkingDir = "/app";
      Entrypoint = [ "/bin/bun" "/app/src/capability-gateway-server.ts" ];
      Env = [
        "PATH=/bin"
        "HOME=${home}"
        "WORKFLOWD_STATE_DIR=${home}"
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"
        "NO_COLOR=1"
      ];
      Labels = {
        "org.opencontainers.image.source" = "https://github.com/BNasraoui/workflowd";
        "org.opencontainers.image.description" = "The workflowd capability gateway";
      };
    };
  };
}
