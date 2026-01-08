# Linear OpenCode Agent

An AI coding agent for Linear that uses OpenCode to handle delegated issues. Supports two deployment modes:

1. **Local Docker Compose** - Uses Docker containers with Tailscale Funnel for public webhook access
2. **Cloudflare Workers** (production) - Uses Cloudflare Sandbox containers for isolated execution

## Features

- **Linear Agent Integration**: Responds to issue delegations and @mentions
- **Real-time Streaming**: Streams OpenCode's work progress as Linear activities
- **Multi-Repo Support**: Automatically resolves repository from GitHub links in issues
- **Session Isolation**: Each session runs in its own git worktree
- **OAuth Authentication**: Uses Claude Max OAuth and Linear MCP OAuth (no API keys needed)
- **Agent Plans**: Syncs OpenCode's todo list to Linear's agent plan UI

## Quick Start (Local Development)

### Prerequisites

- Docker & Docker Compose
- Tailscale account with Funnel enabled
- Linear OAuth app configured
- OpenCode with Claude Max OAuth authenticated locally

### Setup

1. **Clone and install:**

   ```bash
   git clone https://github.com/jackblanc/linear-opencode-agent
   cd linear-opencode-agent
   bun install
   ```

2. **Copy environment template:**

   ```bash
   cp .env.example .env
   ```

3. **Configure `.env`:**

   ```bash
   GITHUB_TOKEN=ghp_...
   TS_AUTHKEY=tskey-auth-...     # From Tailscale admin console
   TAILSCALE_HOSTNAME=linear-agent
   ```

4. **Create `config.docker.json`:**

   ```json
   {
     "port": 3000,
     "tailscaleHostname": "your-hostname.your-tailnet.ts.net",
     "opencode": { "url": "http://opencode:4096" },
     "linear": {
       "clientId": "your-client-id",
       "clientSecret": "your-client-secret",
       "webhookSecret": "lin_wh_...",
       "organizationId": "your-org-id"
     },
     "github": { "token": "ghp_..." },
     "repos": {
       "my-repo": {
         "localPath": "/home/jack.blanc/projects/my-repo",
         "remoteUrl": "https://github.com/owner/my-repo"
       }
     },
     "paths": {
       "worktrees": "/home/jack.blanc/worktrees",
       "data": "/data"
     }
   }
   ```

5. **Start the stack:**

   ```bash
   docker compose up -d
   ```

6. **Authenticate OpenCode (first time only):**

   Run on your host machine to authenticate Claude Max and Linear MCP:

   ```bash
   opencode  # Follow OAuth prompts for Claude Max
   opencode mcp auth linear  # Authenticate Linear MCP
   ```

7. **Copy auth to container and rebuild:**

   ```bash
   ./scripts/rebuild-opencode.sh
   ```

8. **Get your public webhook URL:**

   ```bash
   docker compose exec tailscale tailscale funnel status
   ```

9. **Configure Linear webhook** to point to: `https://your-hostname.ts.net/webhook/linear`

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Webhook Server (linear-webhook container)                │
│                                                          │
│  - Receives Linear webhooks                              │
│  - Verifies signatures + org ID                          │
│  - Resolves repo from issue GitHub links                 │
│  - Creates git worktrees per session                     │
│  - Manages OpenCode sessions via SDK                     │
│                                                          │
│  SSEEventHandler                                         │
│  - message.part.updated → Post tool activities to Linear │
│  - todo.updated → Sync to Linear agent plan              │
│  - permission.updated → Auto-approve all                 │
│  - session.idle → Signal completion                      │
└──────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
    Linear API                   OpenCode Server
                                 (opencode container)
                                 /home/jack.blanc/...
```

### Container Architecture

| Container        | Purpose                         | Ports           |
| ---------------- | ------------------------------- | --------------- |
| `linear-webhook` | Webhook server, session manager | 3000 (local)    |
| `opencode`       | AI coding agent                 | 4096 (internal) |
| `tailscale`      | Exposes webhook via Funnel      | 443 (public)    |

### Security

1. **Webhook signature verification** - Linear SDK verifies HMAC signatures
2. **Organization ID allowlist** - Rejects webhooks from other Linear orgs
3. **Tailscale Funnel** - Public endpoint only exposed via Tailscale
4. **Session isolation** - Each session runs in its own git worktree

## Usage

1. Create a Linear issue
2. Add a GitHub link to the repository (in description or as attachment)
3. Assign/delegate the issue to "OpenCode Agent (Local)"
4. The agent will:
   - Clone the repository to a worktree
   - Analyze the issue
   - Stream progress as Linear activities
   - Update its plan as it works

## Scripts

```bash
# Rebuild and restart OpenCode container (copies auth files)
./scripts/rebuild-opencode.sh

# View logs
docker compose logs -f linear-webhook
docker compose logs -f opencode

# Check Tailscale status
docker compose exec tailscale tailscale funnel status
```

## Project Structure

```
linear-opencode-agent/
├── packages/
│   ├── core/                    # Platform-agnostic core logic
│   │   └── src/
│   │       ├── EventProcessor.ts      # Orchestrates webhook → session → SSE
│   │       ├── SSEEventHandler.ts     # Handles OpenCode SSE events
│   │       ├── session/               # Session lifecycle management
│   │       ├── linear/                # Linear API interface
│   │       └── webhook/               # Webhook verification + dispatch
│   │
│   ├── local/                   # Local development server
│   │   ├── src/
│   │   │   ├── index.ts              # HTTP server + routing
│   │   │   ├── config.ts             # Configuration loader
│   │   │   ├── RepoResolver.ts       # Resolve repo from issue links
│   │   │   └── git/                  # Git worktree management
│   │   └── Dockerfile
│   │
│   ├── linear/                  # Cloudflare Worker entry point
│   └── infrastructure/          # Cloudflare-specific implementations
│
├── docker/
│   └── opencode/
│       ├── Dockerfile           # OpenCode server image
│       ├── opencode.json        # OpenCode config with MCPs
│       └── AGENTS.md            # Agent instructions
│
├── scripts/
│   └── rebuild-opencode.sh      # Rebuild + copy auth
│
├── docker-compose.yml           # Local development stack
├── config.docker.json           # Docker config (gitignored)
└── .env                         # Environment variables (gitignored)
```

## Development

```bash
# Type check
bun run typecheck

# Lint
bun run lint:check
bun run lint:fix

# Format
bun run format:check
bun run format:fix

# All checks
bun run check
```

## Deployment (Cloudflare Workers)

Pushing to `master` triggers GitHub Actions to deploy automatically.

Manual deployment:

```bash
bun run deploy
```

## References

- [Linear Agent Documentation](https://linear.app/developers/agents)
- [OpenCode Documentation](https://opencode.ai/docs)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
