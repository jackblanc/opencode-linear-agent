# @linear-opencode-agent/environment

OpenCode sandbox environment configuration and Docker image.

## Contents

- **Dockerfile** - Extends official `ghcr.io/anomalyco/opencode` image with development tools
- **opencode.json** - OpenCode configuration (model, MCPs, permissions, theme)
- **AGENTS.md** - Custom instructions for agents running in the sandbox
- **plugin/** - OpenCode plugins (commit-guard, etc.)

## Building

```bash
bun run build
```

Or via docker-compose:

```bash
docker compose build opencode
```

## Configuration

The environment includes:

- **Base**: Official OpenCode image (Alpine Linux)
- **Runtime**: Bun
- **Tools**: git, bash, curl, jq, github-cli, ripgrep
- **User**: `/home/user` (matches mounted volume paths)
- **MCPs**: Linear, Context7 (authenticated via OAuth)

## Plugins

### commit-guard

Enforces test passing and clean git state before allowing session completion:

1. Runs tests before allowing commits
2. Requires all changes to be committed
3. Enforces PR creation for non-master branches
