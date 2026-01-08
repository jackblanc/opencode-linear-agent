# Linear webhook server Dockerfile
FROM oven/bun:1
WORKDIR /app

# Install git for worktree operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy everything
COPY . .

# Install dependencies
RUN bun install

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

WORKDIR /app/packages/local
CMD ["bun", "run", "src/index.ts"]
