# Linear webhook server Dockerfile
FROM oven/bun:1
WORKDIR /usr/src/app

# Install git for worktree operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy package files first for caching
COPY package.json bun.lock tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/local/package.json packages/local/package.json
COPY packages/linear/package.json packages/linear/package.json
COPY packages/infrastructure/package.json packages/infrastructure/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/environment/package.json packages/environment/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/core ./packages/core
COPY packages/local ./packages/local

# Create data directory with correct ownership for volume mount
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000/tcp
WORKDIR /usr/src/app/packages/local
ENTRYPOINT ["bun", "run", "src/index.ts"]
