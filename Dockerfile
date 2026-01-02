FROM docker.io/cloudflare/sandbox:0.6.7

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Set higher command timeout for long-running AI operations (10 minutes)
ENV COMMAND_TIMEOUT_MS=600000

# Copy plugin source and build plugins
# Using bun which is available in the sandbox image
COPY packages/opencode-linear-agent /tmp/plugin
RUN cd /tmp/plugin \
    && bun install \
    && mkdir -p /root/.config/opencode/plugin \
    && bun build src/index.ts --outdir /root/.config/opencode/plugin --outfile linear-agent.js --target bun --format esm \
    && bun build src/git-status-hook.ts --outdir /root/.config/opencode/plugin --outfile git-status-hook.js --target bun --format esm \
    && rm -rf /tmp/plugin

# Expose OpenCode server port
EXPOSE 4096
