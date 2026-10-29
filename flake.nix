{
  description = "Reproducible workflowd agent sandbox base image";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { nixpkgs, ... }: {
    packages.x86_64-linux = let
      pkgs = import nixpkgs { system = "x86_64-linux"; };
      image = import ./nix/agent-image.nix { inherit pkgs; };
    in {
      agent-image = image;
      default = image;
    };
  };
}
