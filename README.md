# Linear OpenCode Agent

Self-hosted Linear coding agent powered by OpenCode.

> [!WARNING]
> Alpha software. Self-hosted only. Breaking changes may ship without migration support.
> Not recommended for production workloads.

## Features

- Linear delegation + @mention support
- Real-time activity streaming to Linear
- Repository routing via `repo:name` labels
- Isolated git worktree per agent session
- OAuth-based auth for Linear and OpenCode
- Plan sync from OpenCode todos to Linear agent plans

## Install Modes

- Runtime (recommended): use GitHub release server binary + npm plugin.
- Development: clone repo, run Bun scripts, local plugin build.

## Installation

```bash
# One command interactive setup (recommended)
curl -fsSL https://raw.githubusercontent.com/jackblanc/opencode-linear-agent/master/install | bash

# Optional: pin server release
curl -fsSL https://raw.githubusercontent.com/jackblanc/opencode-linear-agent/master/install | bash -s -- --version v0.1.0
```

Installer binary path priority:

1. `XDG_BIN_DIR`
2. `~/.local/bin` (default)

## Quick Start (Runtime)

1. Install latest server binary and bootstrap config:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/jackblanc/opencode-linear-agent/master/install | bash
   ```

2. Follow prompts for required values:
   - `PUBLIC_HOSTNAME`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `PROJECTS_PATH`

3. Run OpenCode server:

   ```bash
   opencode serve --port 4096 --hostname 127.0.0.1
   ```

4. Start webhook server binary:

   ```bash
   # Usually auto-started by installer service setup.
   # Manual fallback:
   ${XDG_BIN_DIR:-$HOME/.local/bin}/opencode-linear-agent-server
   ```

5. Expose local port `3210` (or your configured `PORT`) using one ingress option from [Ingress Options](#ingress-options).

## Quick Start (Development)

1. Install deps:

   ```bash
   bun install
   ```

2. Copy env and fill required vars:

   ```bash
   cp .env.example .env
   ```

3. Start server:

   ```bash
   bun run start
   ```

## Setup Guide

### 1) Linear OAuth app

1. Open **Linear Settings -> API -> OAuth applications -> New OAuth application**
2. Set redirect URI:
   - `https://<public-hostname>/api/oauth/callback`
3. Enable scopes:
   - `write`
   - `app:mentionable`
   - `app:assignable`
4. Save values:
   - Client ID -> `LINEAR_CLIENT_ID`
   - Client Secret -> `LINEAR_CLIENT_SECRET`

Optional org allowlist ID:

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer <LINEAR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ organization { id name } }"}'
```

Use `organization.id` as `LINEAR_ORGANIZATION_ID`.

### 2) Linear webhook

1. Open **Linear Settings -> API -> Webhooks -> New webhook**
2. Set:
   - URL: `https://<public-hostname>/api/webhook/linear`
   - Events: `AgentSessionEvent` and `Issue`
3. Copy webhook secret to `LINEAR_WEBHOOK_SECRET`

### 3) OpenCode server

Run OpenCode locally so this agent can create sessions:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

Set `OPENCODE_URL=http://localhost:4096` in `.env`.

### 4) Plugin installation (required)

Add plugin to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opencode-linear-agent/plugin"]
}
```

Or use a local build while developing plugin changes:

```bash
bun run --filter @opencode-linear-agent/plugin build
mkdir -p ~/.config/opencode/plugin
cp packages/plugin/dist/index.js ~/.config/opencode/plugin/linear.js
```

Restart `opencode serve` after plugin updates.

Without the plugin, session activity sync and Linear tool integration do not work.

## Behavior Notes

- Plugin and webhook server are separate artifacts and separate release channels.
- Runtime users do not need to clone this repo.
- `install` script is interactive: downloads server binary, adds plugin to OpenCode config, prompts for required Linear env values.
- `install` script initializes background service with stable name (`com.opencode-linear-agent.server` on macOS, `opencode-linear-agent.service` on Linux).
- If existing service config with that name differs, installer warns and skips overwrite.
- Current architecture expects plugin + server to share local state file when running on one machine.
- Split-host/cloud deployments need extra work to replace shared file-state with a network API.

## Ingress Options

Use one option to expose local `:3210` (or your configured `PORT`) publicly for Linear webhooks:

- Cloudflare Tunnel: see `docs/cloudflare-tunnel-setup.md`
- ngrok:
  ```bash
  ngrok http 3210
  ```
- Tailscale Funnel:
  ```bash
  tailscale funnel 3210
  ```

Set `PUBLIC_HOSTNAME` to the hostname from your selected ingress.

## Architecture

```
Linear Webhooks
      |
      v
Ingress Tunnel (Cloudflare Tunnel / ngrok / Tailscale Funnel)
      |
      v
Bun HTTP Server (@opencode-linear-agent/server, :3210)
      |                              |
      v                              v
Linear API                    OpenCode Server (:4096)
```

### Service Architecture

| Service         | Type   | Purpose                                  | Port           |
| --------------- | ------ | ---------------------------------------- | -------------- |
| webhook server  | Bun    | Handles webhooks + session orchestration | 3210 (default) |
| ingress tunnel  | Native | Exposes local webhook endpoint           | -              |
| opencode server | Native | Agent execution backend                  | 4096           |

## Running as a Background Service

`install` already configures this automatically. Use this section only for manual/custom setup.

### Option A: launchd (macOS)

Create `~/Library/LaunchAgents/com.opencode-linear-agent.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencode-linear-agent.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>set -a; source "${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/.env"; set +a; exec "${XDG_BIN_DIR:-$HOME/.local/bin}/opencode-linear-agent-server"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/opencode-linear-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/opencode-linear-agent.log</string>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.opencode-linear-agent.server.plist
launchctl start com.opencode-linear-agent.server
```

### Option B: systemd (Linux)

Create `~/.config/systemd/user/opencode-linear-agent.service`:

```ini
[Unit]
Description=Linear OpenCode Agent webhook server
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash -lc 'set -a; source "${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/.env"; set +a; exec "${XDG_BIN_DIR:-$HOME/.local/bin}/opencode-linear-agent-server"'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-linear-agent
journalctl --user -u opencode-linear-agent -f
```

## Usage

1. Create a Linear issue
2. Add a repo label, ex: `repo:my-repo`
3. Delegate to your OpenCode agent user
4. Agent creates worktree, runs tasks, streams updates, and syncs plan

## Project Structure

```
opencode-linear-agent/
├── packages/
│   ├── core/      # Pure processing logic, handlers, action executor
│   ├── server/    # Bun HTTP webhook server
│   ├── plugin/    # Required OpenCode plugin
│   └── oauth/     # OAuth helpers
├── docs/
├── plans/         # Internal historical planning docs (excluded from publish cleanup in CODE-168)
├── .env.example
└── package.json
```

## Development Commands

```bash
bun run start
bun run dev
bun run typecheck
bun run lint:check
bun run format:check
bun run check
```

## Releases

- Plugin is published to npm as `@opencode-linear-agent/plugin` on `latest`.
- Server is distributed as standalone binaries via GitHub Releases.
- Release automation lives in `.github/workflows/release.yml` and runs on `v*` tags.

## References

- Linear agents: https://linear.app/developers/agents
- Linear webhooks: https://linear.app/developers/webhooks
- OpenCode docs: https://opencode.ai/docs
