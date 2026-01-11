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

4. **Create `config.docker.json`** (repos are auto-discovered):

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
     "paths": {
       "repos": "/home/repos",
       "workspace": "/workspace",
       "data": "/data"
     }
   }
   ```

   Note: Repositories are auto-discovered from `paths.repos`. You can optionally
   add explicit `repos` config to override auto-discovery for specific repos.

5. **Authenticate OpenCode (first time only on host):**

   ```bash
   opencode                    # Follow OAuth prompts for Claude Max
   opencode mcp auth linear    # Authenticate Linear MCP
   ```

6. **Build and start the stack:**

   ```bash
   docker compose build
   docker compose up -d
   ```

7. **Copy auth files to container:**

   ```bash
   docker compose cp ~/.local/share/opencode/auth.json opencode:/home/user/.local/share/opencode/auth.json
   docker compose cp ~/.local/share/opencode/mcp-auth.json opencode:/home/user/.local/share/opencode/mcp-auth.json
   docker compose restart opencode
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
                                 /home/user/...
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

## Common Commands

```bash
# Rebuild containers after code changes
docker compose build
docker compose up -d

# Copy auth files after re-authenticating
docker compose cp ~/.local/share/opencode/auth.json opencode:/home/user/.local/share/opencode/auth.json
docker compose cp ~/.local/share/opencode/mcp-auth.json opencode:/home/user/.local/share/opencode/mcp-auth.json
docker compose restart opencode

# View logs
docker compose logs -f linear-webhook
docker compose logs -f opencode

# Check Tailscale status
docker compose exec tailscale tailscale funnel status
```

## Scheduled Linear Orchestration (macOS)

You can set up a launchd job to automatically triage and manage Linear issues on a schedule using OpenCode's `linear` command.

**Create the launchd plist:**

```bash
cat > ~/Library/LaunchAgents/com.opencode.linear.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.opencode.linear</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/opencode</string>
        <string>run</string>
        <string>--command</string>
        <string>linear</string>
        <string>Review and process Linear issues</string>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardOutPath</key>
    <string>/tmp/opencode-linear.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/opencode-linear.log</string>
</dict>
</plist>
EOF
```

**Note:** Replace `/path/to/opencode` with your actual opencode path (e.g., `which opencode`).

**Manage the job:**

```bash
# Load (enable)
launchctl load ~/Library/LaunchAgents/com.opencode.linear.plist

# Unload (disable)
launchctl unload ~/Library/LaunchAgents/com.opencode.linear.plist

# Check status
launchctl list | grep opencode

# View logs
tail -f /tmp/opencode-linear.log

# Run immediately (for testing)
launchctl start com.opencode.linear
```

The `linear` command acts as an orchestrator that:

- Triages backlog issues
- Delegates work to the OpenCode Agent in Linear
- Monitors PR status and re-assigns when needed
- Updates issue statuses based on outcomes

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
│   ├── environment/             # OpenCode sandbox environment
│   │   ├── Dockerfile           # Extends official OpenCode image
│   │   ├── opencode.json        # OpenCode config with MCPs
│   │   ├── AGENTS.md            # Agent instructions
│   │   └── plugin/              # OpenCode plugins
│   │
│   ├── linear/                  # Cloudflare Worker entry point
│   └── infrastructure/          # Cloudflare-specific implementations
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
