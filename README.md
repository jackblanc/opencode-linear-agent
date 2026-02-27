# Linear OpenCode Agent

Self-hosted Linear coding agent powered by OpenCode.

## Features

- Linear delegation + @mention support
- Real-time activity streaming to Linear
- Repository routing via `repo:name` labels
- Isolated git worktree per agent session
- OAuth-based auth for Linear and OpenCode
- Plan sync from OpenCode todos to Linear agent plans

## Quick Start

1. Install deps:

   ```bash
   bun install
   ```

2. Create env file:

   ```bash
   cp .env.example .env
   ```

3. Fill required vars in `.env`:
   - `PUBLIC_HOSTNAME`
   - `LINEAR_CLIENT_ID`
   - `LINEAR_CLIENT_SECRET`
   - `LINEAR_WEBHOOK_SECRET`
   - `LINEAR_ORGANIZATION_ID`
   - `PROJECTS_PATH`

4. Start server:

   ```bash
   bun run start
   ```

5. Expose local port `3000` using one ingress option from [Ingress Options](#ingress-options).

## Setup Guide

### 1) Linear OAuth app

1. Open **Linear Settings -> API -> OAuth applications -> New OAuth application**
2. Set redirect URI:
   - `https://<public-hostname>/api/oauth/callback`
3. Enable scopes:
   - `read`
   - `write`
   - `issues:create`
   - `comments:create`
4. Save values:
   - Client ID -> `LINEAR_CLIENT_ID`
   - Client Secret -> `LINEAR_CLIENT_SECRET`

Get org ID:

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
   - URL: `https://<public-hostname>/webhook/linear`
   - Events: `Issues` (all issue events)
3. Copy webhook secret to `LINEAR_WEBHOOK_SECRET`

### 3) OpenCode server

Run OpenCode locally so this agent can create sessions:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

Set `OPENCODE_URL=http://localhost:4096` in `.env`.

### 4) Plugin installation (optional)

Build and install plugin:

```bash
bun run --filter @linear-opencode-agent/plugin build
mkdir -p ~/.config/opencode/plugin
cp packages/plugin/dist/index.js ~/.config/opencode/plugin/linear.js
```

Restart `opencode serve` after plugin updates.

## Ingress Options

Use one option to expose local `:3000` publicly for Linear webhooks:

- Cloudflare Tunnel: see `docs/cloudflare-tunnel-setup.md`
- ngrok:
  ```bash
  ngrok http 3000
  ```
- Tailscale Funnel:
  ```bash
  tailscale funnel 3000
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
Bun HTTP Server (@linear-opencode-agent/server, :3000)
      |                              |
      v                              v
Linear API                    OpenCode Server (:4096)
```

### Service Architecture

| Service         | Type   | Purpose                                  | Port |
| --------------- | ------ | ---------------------------------------- | ---- |
| webhook server  | Bun    | Handles webhooks + session orchestration | 3000 |
| ingress tunnel  | Native | Exposes local webhook endpoint           | -    |
| opencode server | Native | Agent execution backend                  | 4096 |

## Running as a Background Service

### Option A: launchd (macOS)

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
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/linear-opencode-agent</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/linear-opencode-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/linear-opencode-agent.log</string>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.linear-opencode-agent.server.plist
launchctl start com.linear-opencode-agent.server
```

### Option B: systemd (Linux)

Create `~/.config/systemd/user/linear-opencode-agent.service`:

```ini
[Unit]
Description=Linear OpenCode Agent webhook server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/linear-opencode-agent
ExecStart=/path/to/bun run start
Restart=always
RestartSec=5
EnvironmentFile=/path/to/linear-opencode-agent/.env

[Install]
WantedBy=default.target
```

Enable service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now linear-opencode-agent
journalctl --user -u linear-opencode-agent -f
```

## Usage

1. Create a Linear issue
2. Add a repo label, ex: `repo:my-repo`
3. Delegate to your OpenCode agent user
4. Agent creates worktree, runs tasks, streams updates, and syncs plan

## Project Structure

```
linear-opencode-agent/
├── packages/
│   ├── core/      # Pure processing logic, handlers, action executor
│   ├── server/    # Bun HTTP webhook server
│   ├── plugin/    # Optional OpenCode plugin
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

## References

- Linear agents: https://linear.app/developers/agents
- Linear webhooks: https://linear.app/developers/webhooks
- OpenCode docs: https://opencode.ai/docs
