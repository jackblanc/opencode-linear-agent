{
  description = "OpenCode sandbox container for Linear agent";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # Support both amd64 and arm64
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };

          # Common packages matching ~/environment setup
          commonPackages = with pkgs; [
            # Core tools
            bash
            coreutils
            gnugrep
            gnused
            gawk
            findutils

            # Development tools (from your common.nix)
            git
            lazygit
            ripgrep
            eza
            gh
            curl
            wget
            jq
            htop

            # Build tools
            bun
            nodejs_22  # For MCP servers that need node

            # OpenCode
            # Note: OpenCode is installed via curl script since it's not in nixpkgs
          ];

          # Script to install OpenCode
          installOpencode = pkgs.writeShellScriptBin "install-opencode" ''
            curl -fsSL https://opencode.ai/install | bash
          '';

        in
        {
          # Docker image for the sandbox
          sandbox = pkgs.dockerTools.buildLayeredImage {
            name = "opencode-sandbox";
            tag = "latest";

            contents = commonPackages ++ [ installOpencode ];

            config = {
              Env = [
                "PATH=/root/.opencode/bin:/root/.bun/bin:${pkgs.lib.makeBinPath commonPackages}"
                "CI=true"
                "COMMAND_TIMEOUT_MS=600000"
                "HOME=/root"
              ];
              WorkingDir = "/workspace";
              Cmd = [ "${pkgs.bash}/bin/bash" "-c" "opencode serve --port 4096 --hostname 0.0.0.0" ];
              ExposedPorts = {
                "4096/tcp" = {};
              };
            };

            # Run setup commands
            extraCommands = ''
              # Create necessary directories
              mkdir -p root/.config/opencode
              mkdir -p root/.local/share/opencode
              mkdir -p workspace

              # Install OpenCode (this runs at build time)
              export HOME=$PWD/root
              export PATH=$PWD/root/.opencode/bin:$PATH
              curl -fsSL https://opencode.ai/install | bash || true

              # Copy config files
              cp ${./opencode.json} root/.config/opencode/opencode.json
              cp ${./AGENTS.md} root/.config/opencode/AGENTS.md
            '';
          };

          default = self.packages.${system}.sandbox;
        });

      # Dev shell for building
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [ docker ];
            shellHook = ''
              echo "Build the sandbox image with: nix build .#sandbox"
              echo "Load it with: docker load < result"
            '';
          };
        });
    };
}
