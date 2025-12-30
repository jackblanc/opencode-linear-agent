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

# Create the plugin directory
RUN mkdir -p /home/user/.config/opencode/plugin

# Copy the built Linear plugin from the workspace
# The plugin-dist directory is populated by the build script before Docker build
COPY plugin-dist/ /home/user/.config/opencode/plugin/linear-opencode-plugin/

# Expose OpenCode server port
EXPOSE 4096
