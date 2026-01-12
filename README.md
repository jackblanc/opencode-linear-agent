# Linear OpenCode Agent

An AI coding agent for Linear that uses OpenCode to handle delegated issues. Supports two deployment modes:

1. **Local Development** - Webhook server in Docker, OpenCode running natively via launchd
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
- OpenCode running as a launchd service (see [Environment Setup](#environment-setup))
- Cloudflare Tunnel configured for public webhook access
- Linear OAuth app configured

### Environment Setup

OpenCode runs natively on your host machine as a launchd service. This is managed via home-manager in `~/environment`:

```nix
# In ~/environment/nix/modules/personal.nix
launchd.agents.opencode = {
  enable = true;
  config = {
    Label = "com.jackblanc.opencode";
    ProgramArguments = [ "${opencode}/bin/opencode" "serve" "--port" "4096" "--hostname" "127.0.0.1" ];
    RunAtLoad = true;
    KeepAlive = true;
  };
};
```

Manage the service with:

```bash
launchctl start com.jackblanc.opencode   # Start
launchctl stop com.jackblanc.opencode    # Stop
launchctl list | grep opencode           # Check status
```

### Setup

1. **Clone and install:**

   ```bash
   git clone https://github.com/jackblanc/linear-opencode-agent
   cd linear-opencode-agent
   bun install
   ```

2. **Create `config.docker.json`:**

   ```json
   {
     "port": 3000,
     "publicHostname": "your-tunnel-hostname.example.com",
     "opencode": { "url": "http://host.docker.internal:4096" },
     "linear": {
       "clientId": "your-client-id",
       "clientSecret": "your-client-secret",
       "webhookSecret": "lin_wh_...",
       "organizationId": "your-org-id"
     },
     "github": { "token": "ghp_..." },
     "paths": {
       "repos": "/home/user/projects",
       "workspace": "/workspace",
       "data": "/data"
     }
   }
   ```

3. **Ensure OpenCode is running:**

   ```bash
   curl http://localhost:4096  # Should return HTML
   ```

4. **Build and start the webhook server:**

   ```bash
   docker compose build
   docker compose up -d
   ```

5. **Configure Linear webhook** to point to your Cloudflare Tunnel URL: `https://your-hostname.example.com/webhook/linear`

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Webhook Server (Docker container)                            │
│                                                              │
│  - Receives Linear webhooks via Cloudflare Tunnel            │
│  - Verifies signatures + org ID                              │
│  - Resolves repo from issue GitHub links                     │
│  - Creates git worktrees per session                         │
│  - Manages OpenCode sessions via SDK                         │
│                                                              │
│  SSEEventHandler                                             │
│  - message.part.updated → Post tool activities to Linear     │
│  - todo.updated → Sync to Linear agent plan                  │
│  - permission.updated → Auto-approve all                     │
│  - session.idle → Signal completion                          │
└──────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
    Linear API                   OpenCode Server
                                 (native launchd service)
                                 http://localhost:4096
```

### Service Architecture

| Service          | Type   | Purpose                         | Port |
| ---------------- | ------ | ------------------------------- | ---- |
| `webhook-server` | Docker | Webhook server, session manager | 3000 |
| `cloudflared`    | Docker | Cloudflare Tunnel               | -    |
| `opencode`       | Native | AI coding agent (launchd)       | 4096 |

### Security

1. **Webhook signature verification** - Linear SDK verifies HMAC signatures
2. **Organization ID allowlist** - Rejects webhooks from other Linear orgs
3. **Cloudflare Tunnel** - Public endpoint protected by Cloudflare
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
# Rebuild webhook server after code changes
docker compose build
docker compose up -d

# View webhook server logs
docker compose logs -f webhook-server

# Check OpenCode server status (native)
launchctl list | grep opencode
curl http://localhost:4096

# Restart OpenCode server
launchctl stop com.jackblanc.opencode && launchctl start com.jackblanc.opencode

# View OpenCode logs
tail -f ~/.local/share/opencode/launchd.log
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
│   │       ├── opencode/              # OpenCode SDK integration
│   │       └── webhook/               # Webhook verification + dispatch
│   │
│   └── server/                  # Webhook server (Docker)
│       ├── src/
│       │   ├── index.ts              # HTTP server + routing
│       │   ├── config.ts             # Configuration loader
│       │   ├── RepoResolver.ts       # Resolve repo from issue labels
│       │   └── storage/              # File-based storage
│       └── Dockerfile
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
