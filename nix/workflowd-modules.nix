{ pkgs, bun }:
# The frozen production node_modules of bun.lock, with no install scripts. The output hash pins
# the result: a second build that differs fails here instead of changing the image.
pkgs.stdenvNoCC.mkDerivation {
  name = "workflowd-node-modules";
  src = pkgs.lib.fileset.toSource {
    root = ../.;
    fileset = pkgs.lib.fileset.unions [ ../package.json ../bun.lock ];
  };
  nativeBuildInputs = [ bun ];
  SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  dontConfigure = true;
  buildPhase = ''
    export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
    bun install --frozen-lockfile --ignore-scripts --production --no-progress --backend=copyfile
  '';
  installPhase = ''
    mkdir $out
    mv node_modules $out/node_modules
  '';
  dontFixup = true;
  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = pkgs.lib.fakeHash;
}
