# OpenCode server Dockerfile
FROM debian:bookworm-slim

# Install dependencies (bash required for OpenCode tool execution)
RUN apt-get update && apt-get install -y \
    bash \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI
ENV PATH="/root/.opencode/bin:${PATH}"
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Set CI=true to skip interactive prompts
ENV CI=true

# Set higher command timeout for long-running AI operations (10 minutes)
ENV COMMAND_TIMEOUT_MS=600000

# Create workspace directory
WORKDIR /workspace

EXPOSE 4096

# Start OpenCode server (bind to 0.0.0.0 so other containers can reach it)
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
