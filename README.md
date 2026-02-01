# Linear OpenCode Agent

An AI coding agent for Linear that uses OpenCode to handle delegated issues.

## Features

- **Linear Agent Integration**: Responds to issue delegations and @mentions
- **Real-time Streaming**: Streams OpenCode's work progress as Linear activities
- **Multi-Repo Support**: Resolves repository from `repo:name` labels on issues
- **Session Isolation**: Each session runs in its own git worktree
- **OAuth Authentication**: Uses Claude Max OAuth and Linear MCP OAuth (no API keys needed)
- **Agent Plans**: Syncs OpenCode's todo list to Linear's agent plan UI

## Quick Start

For a complete walkthrough, see the [Setup Guide](#setup-guide) below.

### Prerequisites

- macOS (for launchd) or Linux (use systemd instead)
- [Bun](https://bun.sh) runtime
- A Cloudflare account (for Cloudflare Tunnel, free tier works)
- A Linear workspace with admin access

---

## Setup Guide

This guide walks through setting up the agent from scratch on a fresh machine.

### 1. Linear OAuth App Setup

Create an OAuth application in Linear to allow the agent to authenticate:

1. Go to **Linear Settings** → **API** → **OAuth applications** → **New OAuth application**
2. Fill in the details:
   - **Application name**: `OpenCode Agent` (or your preferred name)
   - **Developer name**: Your name
   - **Developer URL**: Your website or GitHub
   - **Redirect URIs**: `https://your-tunnel-hostname.example.com/api/oauth/callback` (update after tunnel setup)
3. Under **Permissions**, enable:
   - `read` - Read access to resources
   - `write` - Write access to resources
   - `issues:create` - Create issues
   - `comments:create` - Create comments
4. Click **Create** and save:
   - **Client ID** → `linear.clientId` in config
   - **Client Secret** → `linear.clientSecret` in config

**Get your Organization ID:**

1. Go to **Linear Settings** → **API** → **Personal API keys**
2. Your organization ID is shown at the top, or use the GraphQL API:
   ```bash
   curl -X POST https://api.linear.app/graphql \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ organization { id name } }"}'
   ```

**Create a Webhook:**

1. Go to **Linear Settings** → **API** → **Webhooks** → **New webhook**
2. Configure:
   - **Label**: `OpenCode Agent`
   - **URL**: `https://your-tunnel-hostname.example.com/webhook/linear` (update after tunnel setup)
   - **Events**: Select `Issues` (all issue events)
3. Save the **Webhook secret** → `linear.webhookSecret` in config

### 2. Cloudflare Tunnel Setup

Cloudflare Tunnel exposes your local webhook server to the internet securely.

1. **Install cloudflared:**

   ```bash
   brew install cloudflared
   ```

2. **Authenticate with Cloudflare:**

   ```bash
   cloudflared tunnel login
   ```

   This opens a browser to authenticate and stores credentials at `~/.cloudflared/cert.pem`.

3. **Create a tunnel:**

   ```bash
   cloudflared tunnel create linear-webhook
   ```

   This creates `~/.cloudflared/<TUNNEL_ID>.json` with credentials.

4. **Configure the tunnel:**
   Create `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: linear-webhook
   credentials-file: /Users/YOUR_USERNAME/.cloudflared/<TUNNEL_ID>.json

   ingress:
     - hostname: your-subdomain.your-domain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

5. **Create DNS record:**

   ```bash
   cloudflared tunnel route dns linear-webhook your-subdomain.your-domain.com
   ```

6. **Install as a background service:**

   ```bash
   cloudflared service install
   ```

   This creates a launchd agent (macOS) or systemd unit (Linux) that starts the tunnel automatically on boot using your `~/.cloudflared/config.yml`.

7. **Update Linear OAuth & Webhook URLs** with your new hostname.

### 3. OpenCode Server Setup

OpenCode needs to run as a background service. Choose one of these methods:

#### Option A: launchd (macOS)

Create `~/Library/LaunchAgents/com.opencode.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.opencode.serve</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/opencode</string>
        <string>serve</string>
        <string>--port</string>
        <string>4096</string>
        <string>--hostname</string>
        <string>127.0.0.1</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/opencode-serve.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/opencode-serve.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/YOUR_USERNAME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
```

**Important:** Replace `/path/to/opencode` with the actual path (run `which opencode` to find it) and `YOUR_USERNAME` with your username.

Load and start the service:

```bash
launchctl load ~/Library/LaunchAgents/com.opencode.serve.plist
launchctl start com.opencode.serve
```

Verify it's running:

```bash
curl http://localhost:4096  # Should return HTML
launchctl list | grep opencode
tail -f /tmp/opencode-serve.log
```

#### Option B: Nix/home-manager (Alternative)

If you use Nix with home-manager:

```nix
launchd.agents.opencode = {
  enable = true;
  config = {
    Label = "com.opencode.serve";
    ProgramArguments = [ "${opencode}/bin/opencode" "serve" "--port" "4096" "--hostname" "127.0.0.1" ];
    RunAtLoad = true;
    KeepAlive = true;
  };
};
```

### 4. Clone and Configure

1. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/jackblanc/linear-opencode-agent
   cd linear-opencode-agent
   bun install
   ```

2. **Configure environment variables:**

   ```bash
   cp .env.example .env
   ```

   Fill in your values in `.env` (see `.env.example` for all available variables).

3. **Create the data directory:**

   ```bash
   mkdir -p ~/.local/share/linear-opencode-agent
   ```

4. **Verify OpenCode is running:**

   ```bash
   curl http://localhost:4096  # Should return HTML
   ```

5. **Start the webhook server:**

   ```bash
   bun run start
   ```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Webhook Server (Bun process)                                 │
│                                                              │
│  - Receives Linear webhooks via Cloudflare Tunnel            │
│  - Verifies signatures + org ID                              │
│  - Resolves repo from issue repo:X labels                    │
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
                                 (launchd/systemd service)
                                 http://localhost:4096
```

### Service Architecture

| Service          | Type   | Purpose                         | Port |
| ---------------- | ------ | ------------------------------- | ---- |
| `webhook-server` | Bun    | Webhook server, session manager | 3000 |
| `cloudflared`    | Native | Cloudflare Tunnel               | -    |
| `opencode`       | Native | AI coding agent (launchd)       | 4096 |

### Security

1. **Webhook signature verification** - Linear SDK verifies HMAC signatures
2. **Organization ID allowlist** - Rejects webhooks from other Linear orgs
3. **Cloudflare Tunnel** - Public endpoint protected by Cloudflare
4. **Session isolation** - Each session runs in its own git worktree

## Usage

1. Create a Linear issue
2. Add a `repo:name` label to specify the repository (e.g., `repo:my-project` or `repo:org/my-project`)
3. Assign/delegate the issue to "OpenCode Agent (Local)"
4. The agent will:
   - Create a git worktree in the specified repository
   - Analyze the issue
   - Stream progress as Linear activities
   - Update its plan as it works

**Note:** The repository must exist at `projectsPath/name` (the org prefix is ignored if provided).

## Running as a Background Service

The webhook server needs to stay running to receive Linear webhooks. Here are options for keeping it alive:

### Option A: launchd (macOS, recommended)

Create `~/Library/LaunchAgents/com.linear-opencode-agent.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.linear-opencode-agent.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/bun</string>
        <string>run</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/linear-opencode-agent/packages/server</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/linear-opencode-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/linear-opencode-agent.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/YOUR_USERNAME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>PUBLIC_HOSTNAME</key>
        <string>your-subdomain.your-domain.com</string>
        <key>LINEAR_CLIENT_ID</key>
        <string>your-client-id</string>
        <key>LINEAR_CLIENT_SECRET</key>
        <string>your-client-secret</string>
        <key>LINEAR_WEBHOOK_SECRET</key>
        <string>your-webhook-secret</string>
        <key>LINEAR_ORGANIZATION_ID</key>
        <string>your-org-id</string>
        <key>PROJECTS_PATH</key>
        <string>/Users/YOUR_USERNAME/projects</string>
    </dict>
</dict>
</plist>
```

Replace paths and env var values, then load:

```bash
launchctl load ~/Library/LaunchAgents/com.linear-opencode-agent.server.plist
launchctl start com.linear-opencode-agent.server

# Verify
launchctl list | grep linear-opencode
tail -f /tmp/linear-opencode-agent.log
```

### Option B: systemd (Linux)

Create `~/.config/systemd/user/linear-opencode-agent.service`:

```ini
[Unit]
Description=Linear OpenCode Agent webhook server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/linear-opencode-agent/packages/server
ExecStart=/path/to/bun run src/index.ts
Restart=always
RestartSec=5
EnvironmentFile=/path/to/linear-opencode-agent/.env

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now linear-opencode-agent
journalctl --user -u linear-opencode-agent -f
```

### Option C: Terminal (development)

For development, run directly in a terminal:

```bash
bun run dev
```

## Common Commands

```bash
# Start webhook server
bun run start

# Start in dev mode (auto-reload on changes)
bun run dev

# Check OpenCode server status
launchctl list | grep opencode
curl http://localhost:4096

# Restart OpenCode server
launchctl stop com.opencode.serve && launchctl start com.opencode.serve

# View OpenCode logs
tail -f /tmp/opencode-serve.log
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
│   │       ├── LinearEventProcessor.ts  # Orchestrates webhook → session → SSE
│   │       ├── handlers/                # Event handlers (Tool, Text, Todo, etc.)
│   │       ├── session/                 # Session lifecycle management
│   │       ├── linear/                  # Linear API interface
│   │       ├── opencode/                # OpenCode SDK integration
│   │       ├── webhook/                 # Webhook verification + dispatch
│   │       ├── actions/                 # Action types and executor
│   │       ├── errors/                  # Tagged error types
│   │       ├── oauth/                   # OAuth flow handlers
│   │       └── storage/                 # Storage interface
│   │
│   ├── server/                  # Webhook server (Bun)
│   │   └── src/
│   │       ├── index.ts              # HTTP server + routing
│   │       ├── config.ts             # Configuration loader (env vars)
│   │       └── RepoResolver.ts       # Resolve repo from issue labels
│   │
│   ├── plugin/                  # OpenCode plugin (optional)
│   │   └── src/                      # Hooks into OpenCode events
│   │
│   └── oauth/                   # OAuth utilities
│       └── src/                      # Token management
│
├── .env                         # Environment variables (gitignored)
└── .env.example                 # Template for env vars
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
