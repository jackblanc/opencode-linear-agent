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

## Installation

```bash
# Install webhook server
bun add -g @opencode-linear-agent/server
# or: npm i -g @opencode-linear-agent/server
```

Add plugin to OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opencode-linear-agent/plugin@latest"]
}
```

Use `@stable` instead of `@latest` if you prefer tagged releases only.

## Quick Start (Runtime)

1. Install server from npm:

   ```bash
   bun add -g @opencode-linear-agent/server
   # or: npm i -g @opencode-linear-agent/server
   ```

2. Create env file (default: `~/.local/share/opencode-linear-agent/.env`):

   ```bash
   DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent"
   ENV_FILE="$DATA_DIR/.env"
   mkdir -p "$DATA_DIR"
   cat > "$ENV_FILE" <<'EOF'
   # Server
   PORT=3210
   PUBLIC_HOSTNAME=your-hostname.example.com

   # OpenCode
   OPENCODE_URL=http://localhost:4096

   # Linear OAuth
   LINEAR_CLIENT_ID=
   LINEAR_CLIENT_SECRET=

   # Linear Webhook
   LINEAR_WEBHOOK_SECRET=

   # Optional: restrict to one org
   # LINEAR_ORGANIZATION_ID=

   # Local repos root
   PROJECTS_PATH=$HOME/projects
   EOF
   ```

3. Run OpenCode server:

   ```bash
   opencode serve --port 4096 --hostname 127.0.0.1
   ```

4. Start webhook server binary:

   ```bash
   ${XDG_BIN_DIR:-$HOME/.local/bin}/opencode-linear-agent-server
   ```

5. Complete setup:
   - Configure OAuth app + webhook in Linear (see [Setup Guide](#setup-guide))
   - Expose local port `3210` (or your `PORT`) with [Ingress Options](#ingress-options)
   - Restart OpenCode after plugin config changes

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

Set `OPENCODE_URL=http://localhost:4096` in your env file (`~/.local/share/opencode-linear-agent/.env` by default).

### 4) Plugin installation (required)

Set plugin in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opencode-linear-agent/plugin@latest"]
}
```

Restart `opencode serve` after plugin updates.

Without the plugin, session activity sync and Linear tool integration do not work.

## Behavior Notes

- Plugin and webhook server are separate artifacts and separate release channels.
- Runtime users do not need to clone this repo.
- Current architecture expects plugin + server to share local state file when running on one machine.
- Split-host/cloud deployments need extra work to replace shared file-state with a network API.

## Logs

- Plugin logs live under OpenCode's log dir: `~/.local/share/opencode/log/` on macOS/Linux.
- Webhook server structured logs go to stderr and per-start files under the agent data dir: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/log/server-*.log`.
- The startup banner still prints to stdout.
- Extra stdout/stderr capture still depends on how you run the server, ex: launchd, systemd, Docker, or a terminal.

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
systemctl --user enable --now opencode-linear-agent.service
journalctl --user -u opencode-linear-agent.service -f
```

The app-managed webhook logs still land in `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/log/`. `StandardOutPath`, `StandardErrorPath`, `journalctl`, or terminal output only control extra stdout/stderr capture.

## Usage

1. Create a Linear issue
2. Add a repo label, ex: `repo:my-repo`
3. Delegate to your OpenCode agent user
4. Agent creates worktree, runs tasks, streams updates, and syncs plan

## Runtime Behavior

### Repository label routing

- `repo:*` label is required for execution.
- Accepted formats:
  - `repo:my-repo`
  - `repo:org/my-repo` (org segment is ignored for local path resolution)
- Resolver maps to local path under `PROJECTS_PATH`, ex: `repo:my-repo` -> `${PROJECTS_PATH}/my-repo`.
- Missing/invalid `repo:*` blocks execution before worktree/session creation and posts an actionable error to Linear.

### Plan vs build mode

- Mode is selected from Linear issue **state type**:
  - `triage` or `backlog` -> `plan` mode
  - everything else (`unstarted`, `started`, `completed`, `canceled`) -> `build` mode
- `plan` mode: agent analyzes and updates issue with an implementation plan; no code changes/PR expected.
- `build` mode: agent implements changes and is instructed to create a PR when work is complete.
- In `build` mode only, the issue is moved to **In Progress** when processing starts.

## Project Structure

```
opencode-linear-agent/
├── packages/
│   ├── core/      # Pure processing logic, handlers, action executor
│   ├── server/    # Bun HTTP webhook server
│   ├── plugin/    # Required OpenCode plugin
├── docs/
├── plans/         # Internal historical planning docs (excluded from publish cleanup in CODE-168)
├── .env.example
└── package.json
```

## Releases

- `latest` channel tracks `master` via `.github/workflows/release.yml`.
- Tagged releases (`v*`) publish to npm `stable` via `.github/workflows/release.yml`.
- Plugin package: `@opencode-linear-agent/plugin`.
- Server package: `@opencode-linear-agent/server`.
- Server standalone binaries are also published via GitHub Releases.

## References

- Linear agents: https://linear.app/developers/agents
- Linear webhooks: https://linear.app/developers/webhooks
- OpenCode docs: https://opencode.ai/docs
