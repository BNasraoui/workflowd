{
  description = "Reproducible workflowd images: the agent sandbox base and the capability gateway";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { nixpkgs, ... }: {
    packages.x86_64-linux = let
      pkgs = import nixpkgs { system = "x86_64-linux"; };
      image = import ./nix/agent-image.nix { inherit pkgs; };
      gateway = import ./nix/gateway-image.nix { inherit pkgs; };
    in {
      agent-image = image;
      gateway-image = gateway.image;
      gateway-bun = gateway.bun;
      gateway-noscope = gateway.noscope;
      gateway-modules = gateway.modules;
      gateway-app = gateway.app;
      default = image;
    };
  };
}
