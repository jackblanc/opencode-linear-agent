# OpenCode sandbox container
#
# Simple Debian-based container with essential dev tools
# Uses /home/jack.blanc to match work Linux machine paths

FROM debian:bookworm-slim

# Install base dependencies and dev tools
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    jq \
    ripgrep \
    htop \
    fzf \
    bat \
    neovim \
    gh \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Create home directory structure
RUN mkdir -p /home/jack.blanc/.config/opencode \
             /home/jack.blanc/.local/share/opencode \
             /home/jack.blanc/projects \
             /home/jack.blanc/worktrees

# Set home directory
ENV HOME=/home/jack.blanc
WORKDIR /home/jack.blanc

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/jack.blanc/.bun/bin:$PATH"

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/home/jack.blanc/.opencode/bin:$PATH"

# Environment
ENV CI=true
ENV COMMAND_TIMEOUT_MS=600000

# Copy config and plugins
COPY opencode.json /home/jack.blanc/.config/opencode/opencode.json
COPY AGENTS.md /home/jack.blanc/.config/opencode/AGENTS.md
COPY plugin/ /home/jack.blanc/.config/opencode/plugin/

WORKDIR /home/jack.blanc/projects
EXPOSE 4096

CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
