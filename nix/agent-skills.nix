{ pkgs }:
let
  catalogFile = ../deploy/sandbox/skills/catalog.json;
  catalog = builtins.fromJSON (builtins.readFile catalogFile);
  sources = builtins.mapAttrs (_: source: pkgs.fetchFromGitHub {
    owner = builtins.elemAt (pkgs.lib.splitString "/" source.repository) 0;
    repo = builtins.elemAt (pkgs.lib.splitString "/" source.repository) 1;
    inherit (source) rev hash;
  }) catalog.sources;
  python = pkgs.python3.withPackages (ps: [ ps.pyyaml ]);
in
pkgs.runCommand "workflowd-sandbox-skills" { nativeBuildInputs = [ python ]; } ''
  mkdir -p "$out${catalog.root}" upstream
  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: source: ''
    ln -s ${source} upstream/${name}
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
