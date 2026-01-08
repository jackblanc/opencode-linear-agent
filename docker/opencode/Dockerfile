# OpenCode sandbox container
# 
# Option 1: Build from ~/environment Nix flake (recommended)
#   cd ~/environment
#   nix build .#sandbox
#   docker load < result
#
# Option 2: Use this Dockerfile directly (fallback)
#   docker build -t opencode-sandbox ./docker/opencode

FROM nixos/nix:latest AS builder

# Enable flakes
RUN echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf

# Install packages via nix profile (matching ~/environment/nix/packages/sandbox.nix)
RUN nix profile install \
    nixpkgs#bash \
    nixpkgs#coreutils \
    nixpkgs#gnugrep \
    nixpkgs#gnused \
    nixpkgs#gawk \
    nixpkgs#findutils \
    nixpkgs#cacert \
    nixpkgs#git \
    nixpkgs#lazygit \
    nixpkgs#ripgrep \
    nixpkgs#eza \
    nixpkgs#gh \
    nixpkgs#curl \
    nixpkgs#wget \
    nixpkgs#jq \
    nixpkgs#htop \
    nixpkgs#bun \
    nixpkgs#neovim \
    nixpkgs#bat \
    nixpkgs#fzf \
    --profile /nix-profile

# Install OpenCode
ENV HOME=/root
ENV PATH="/root/.opencode/bin:$PATH"
RUN curl -fsSL https://opencode.ai/install | bash

# Final stage
FROM nixos/nix:latest

# Copy Nix profile and store
COPY --from=builder /nix-profile /nix-profile
COPY --from=builder /nix/store /nix/store
COPY --from=builder /root/.opencode /root/.opencode

# Environment
ENV PATH="/root/.opencode/bin:/nix-profile/bin:$PATH"
ENV CI=true
ENV COMMAND_TIMEOUT_MS=600000
ENV HOME=/root
ENV SSL_CERT_FILE=/nix-profile/etc/ssl/certs/ca-bundle.crt
ENV NIX_SSL_CERT_FILE=/nix-profile/etc/ssl/certs/ca-bundle.crt

# Create directories
RUN mkdir -p /root/.config/opencode /root/.local/share/opencode /workspace

# Copy config
COPY opencode.json /root/.config/opencode/opencode.json
COPY AGENTS.md /root/.config/opencode/AGENTS.md

WORKDIR /workspace
EXPOSE 4096

CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
