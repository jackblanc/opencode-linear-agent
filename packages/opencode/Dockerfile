# OpenCode sandbox environment
# Extends official OpenCode image with development tools
# Designed to be stateless and sandboxable

FROM ghcr.io/anomalyco/opencode:latest

# Install essential development tools
RUN apk add --no-cache \
    git \
    bash \
    curl \
    jq \
    github-cli \
    sudo

# Create non-root user (uid 1000 for compatibility)
RUN addgroup -g 1000 user && \
    adduser -u 1000 -G user -D -h /home/user user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# Install Bun runtime (system-wide)
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx && \
    chmod +x /usr/local/bin/bun

# Create directory structure aligned with Cloudflare conventions
RUN mkdir -p /home/repos \
             /workspace \
             /workspace/data \
             /home/user/.config/opencode \
             /home/user/.local/share/opencode && \
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

# Set working directory
WORKDIR /workspace

# Run as non-root user
USER user

# Expose OpenCode server port
EXPOSE 4096

# Start OpenCode server (base image has ENTRYPOINT ["opencode"])
CMD ["serve", "--port", "4096", "--hostname", "0.0.0.0"]
