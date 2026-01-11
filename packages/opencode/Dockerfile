# OpenCode sandbox environment
# Uses Ubuntu for glibc compatibility (required by SST's bundled binaries)
# Designed to be stateless and sandboxable

FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install essential development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    jq \
    unzip \
    ca-certificates \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 already has ubuntu:ubuntu with uid/gid 1000
# Rename to 'user' for consistency with our setup, and configure sudo
RUN usermod -l user -d /home/user -m ubuntu && \
    groupmod -n user ubuntu && \
    echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# Install Bun runtime (system-wide)
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
    chmod +x /usr/local/bin/bun

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash && \
    find /root -name opencode -type f 2>/dev/null | head -1 | xargs -I {} cp {} /usr/local/bin/opencode && \
    chmod +x /usr/local/bin/opencode

# Create directory structure aligned with Cloudflare conventions
RUN mkdir -p /home/repos \
             /workspace \
             /workspace/data \
             /home/user/.config/opencode \
             /home/user/.local/share/opencode \
             /home/user/.local/bin && \
    chown -R user:user /home/repos /workspace /home/user

# Copy OpenCode configuration and plugins
COPY --chown=user:user opencode.json /home/user/.config/opencode/opencode.json
COPY --chown=user:user AGENTS.md /home/user/AGENTS.md
COPY --chown=user:user plugin/ /home/user/.config/opencode/plugin/

# Environment variables
ENV HOME=/home/user
ENV CI=true
ENV COMMAND_TIMEOUT_MS=600000
ENV REPOS_DIR=/home/repos
ENV WORKSPACE_DIR=/workspace
ENV PATH="/home/user/.local/bin:${PATH}"

# Set working directory
WORKDIR /workspace

# Run as non-root user
USER user

# Expose OpenCode server port
EXPOSE 4096

# Start OpenCode server
ENTRYPOINT ["opencode"]
CMD ["serve", "--port", "4096", "--hostname", "0.0.0.0"]
