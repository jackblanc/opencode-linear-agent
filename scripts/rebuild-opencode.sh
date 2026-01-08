#!/usr/bin/env bash
# Rebuild and restart the OpenCode sandbox container
# Copies auth files from host for Claude Max and Linear MCP OAuth

set -euo pipefail

cd "$(dirname "$0")/.."

echo "Rebuilding opencode container..."
docker compose up -d --build opencode

echo "Copying auth files..."
docker compose cp ~/.local/share/opencode/auth.json opencode:/home/jack.blanc/.local/share/opencode/auth.json
docker compose cp ~/.local/share/opencode/mcp-auth.json opencode:/home/jack.blanc/.local/share/opencode/mcp-auth.json

echo "Restarting opencode..."
docker compose restart opencode

sleep 2
echo ""
echo "Status:"
docker compose ps opencode
echo ""
docker compose logs opencode --tail 5
