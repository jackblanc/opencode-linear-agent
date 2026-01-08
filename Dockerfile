FROM docker.io/cloudflare/sandbox:0.6.7

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Set CI=true so tools like SST skip interactive prompts
# This must be set early so it's available during any RUN commands
ENV CI=true

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Set higher command timeout for long-running AI operations (10 minutes)
ENV COMMAND_TIMEOUT_MS=600000

# No plugin needed - all Linear integration is handled via SSE in the worker

# Expose OpenCode server port
EXPOSE 4096
