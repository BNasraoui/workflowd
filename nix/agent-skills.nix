{ pkgs }:
let
  catalogFile = ../deploy/sandbox/skills/catalog.json;
  catalog = builtins.fromJSON (builtins.readFile catalogFile);
  sources = builtins.mapAttrs (_: source: pkgs.fetchurl {
    url = "https://codeload.github.com/${source.repository}/tar.gz/${source.rev}";
    inherit (source) hash;
  }) catalog.sources;
  python = pkgs.python3.withPackages (ps: [ ps.pyyaml ]);
in
pkgs.runCommand "workflowd-sandbox-skills" { nativeBuildInputs = [ python ]; } ''
  mkdir -p "$out${catalog.root}" upstream
  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: archive: ''
    mkdir upstream/${name}
    tar -xzf ${archive} --strip-components=1 -C upstream/${name}
  '') sources)}
  ${pkgs.lib.concatMapStringsSep "\n" (skill: let
    source = if skill ? vendored
      then ../deploy/sandbox/skills + "/${skill.vendored}"
      else "upstream/${skill.source}/${skill.directory}";
  in ''
    cp -R ${source} "$out${catalog.root}/${skill.name}"
    chmod -R u+w "$out${catalog.root}/${skill.name}"
    cp upstream/${skill.source}/${skill.license} "$out${catalog.root}/${skill.name}/LICENSE.upstream"
  '') catalog.skills}
  chmod -R a-w "$out"
  python ${../scripts/check-sandbox-skills.py} "$out${catalog.root}" < ${catalogFile}
''
