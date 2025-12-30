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

# Copy the built Linear agent plugin into the global OpenCode plugin directory
# This plugin streams events to Linear's API
# NOTE: The plugin must be built before deploying (bun run build)
COPY packages/opencode-linear-agent/dist/index.js /home/user/.config/opencode/plugin/linear-agent.js

# Expose OpenCode server port
EXPOSE 4096
