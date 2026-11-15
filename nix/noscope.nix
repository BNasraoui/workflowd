{ pkgs }:
# noscope at the revision that CI installs for the capability suites.
let
  src = builtins.fetchGit {
    url = "https://github.com/BNasraoui/noscope.git";
    rev = "0e87a571de0c76c83af7c46e767c0d5b650a7886";
    allRefs = true;
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "noscope";
  version = "0.1.0-0e87a571";
  inherit src;
  cargoLock = {
    lockFile = "${src}/Cargo.lock";
    # One git dependency, pinned by its full revision in Cargo.lock.
    allowBuiltinFetchGit = true;
  };
  doCheck = false;
}
