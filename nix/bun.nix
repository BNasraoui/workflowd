{ pkgs }:
# Bun 1.3.14, the release that CI and package.json's tooling use, from its published archive.
pkgs.stdenv.mkDerivation {
  pname = "bun";
  version = "1.3.14";
  src = pkgs.fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip";
    sha256 = "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f";
  };
  sourceRoot = "bun-linux-x64";
  nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];
  dontConfigure = true;
  dontBuild = true;
  # The executable carries its own embedded data; stripping it breaks the binary.
  dontStrip = true;
  installPhase = ''
    install -Dm755 bun $out/bin/bun
  '';
}
