# Linear webhook server Dockerfile
FROM oven/bun:1-alpine

WORKDIR /app

# Copy package files first for caching
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/oauth/package.json packages/oauth/package.json
COPY packages/plugin/package.json packages/plugin/package.json
COPY packages/server/package.json packages/server/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/core ./packages/core
COPY packages/server ./packages/server

# Create data directory with correct ownership for volume mount
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000/tcp
WORKDIR /app/packages/server
ENTRYPOINT ["bun", "run", "src/index.ts"]
