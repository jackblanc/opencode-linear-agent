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

Global npm install pulls a native platform binary. Bun and Node are not required at runtime.

```bash
# Install webhook server
npm i -g @opencode-linear-agent/server
```

Add plugin to OpenCode config (`$XDG_CONFIG_HOME/opencode/opencode.json`, default `~/.config/opencode/opencode.json`):

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
   npm i -g @opencode-linear-agent/server
   ```

2. Create configuration file at `$XDG_CONFIG_HOME/opencode-linear-agent/config.json` (default `~/.config/opencode-linear-agent/config.json`):

   ```json
   {
     "webhookServerPublicHostname": "your-hostname.example.com",
     "webhookServerPort": 3210,
     "opencodeServerUrl": "http://localhost:4096",
     "linearClientId": "<linear-client-id>",
     "linearClientSecret": "<linear-client-secret>",
     "linearWebhookSecret": "<linear-webhook-secret>",
     "projectsPath": "/Users/you/projects"
   }
   ```

   Optional keys:
   - `linearOrganizationId`: restrict webhook processing to one Linear org
   - `linearWebhookIps`: override the default Linear webhook IP allowlist

3. Start services:

   ```bash
   opencode-linear-agent
   ```

   macOS managed-service path:

   ```bash
   opencode-linear-agent setup
   ```

   On macOS, `setup` also ensures a persistent OpenCode launchd service for the exact configured `opencodeServerUrl` when that URL is a local `http://localhost:<port>` or `http://127.0.0.1:<port>` endpoint.

4. Complete setup:
   - Configure OAuth app + webhook in Linear (see [Setup Guide](#setup-guide))
   - Expose local port `3210` (or your configured `webhookServerPort`) with [Ingress Options](#ingress-options)
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
4. Save values into `$XDG_CONFIG_HOME/opencode-linear-agent/config.json` (default `~/.config/opencode-linear-agent/config.json`):
   - Client ID -> `linearClientId`
   - Client Secret -> `linearClientSecret`

Optional org allowlist ID:

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer <LINEAR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ organization { id name } }"}'
```

Use `organization.id` as `linearOrganizationId` if you want to restrict webhooks to one org.

### 2) Linear webhook

1. Open **Linear Settings -> API -> Webhooks -> New webhook**
2. Set:
   - URL: `https://<public-hostname>/api/webhook/linear`
   - Events: `AgentSessionEvent` and `Issue`
3. Copy webhook secret to `linearWebhookSecret` in `$XDG_CONFIG_HOME/opencode-linear-agent/config.json` (default `~/.config/opencode-linear-agent/config.json`)

### 3) OpenCode server

Run OpenCode locally so this agent can create sessions, or let `opencode-linear-agent setup` install a managed macOS launchd service for the exact configured local URL:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

Set `opencodeServerUrl` to an exact local HTTP endpoint like `http://localhost:4096` in `$XDG_CONFIG_HOME/opencode-linear-agent/config.json` (default `~/.config/opencode-linear-agent/config.json`). Non-local URLs are not eligible for managed setup.

### 4) Plugin installation (required)

Set plugin in `$XDG_CONFIG_HOME/opencode/opencode.json` (default `~/.config/opencode/opencode.json`):

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
- Current architecture expects plugin + server to share local state file at `$XDG_DATA_HOME/opencode-linear-agent/store.json` (default `~/.local/share/opencode-linear-agent/store.json`) when running on one machine.
- Split-host/cloud deployments need extra work to replace shared file-state with a network API.

## Logs

- Plugin logs live under OpenCode's log dir: `~/.local/share/opencode/log/` on macOS/Linux.
- Webhook server logs are always pretty-printed, mirrored to `stderr`, and written to per-start files under the agent data dir: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/log/server-*.log`.
- The startup banner still prints to stdout.
- Extra stdout/stderr capture still depends on how you run the server, ex: launchd, systemd, Docker, or a terminal.

## Ingress Options

Use one option to expose local `:3210` (or your configured `webhookServerPort`) publicly for Linear webhooks:

- Cloudflare Tunnel: see `docs/cloudflare-tunnel-setup.md`
- ngrok:
  ```bash
  ngrok http 3210
  ```
- Tailscale Funnel:
  ```bash
  tailscale funnel 3210
  ```

Set `webhookServerPublicHostname` to the hostname from your selected ingress.

## Architecture

```
Linear Webhooks
      |
      v
Ingress Tunnel (Cloudflare Tunnel / ngrok / Tailscale Funnel)
      |
      v
Native Server Binary (@opencode-linear-agent/server, :3210)
      |                              |
      v                              v
Linear API                    OpenCode Server (:4096)
```

### Service Architecture

| Service         | Type   | Purpose                                  | Port           |
| --------------- | ------ | ---------------------------------------- | -------------- |
| webhook server  | Native | Handles webhooks + session orchestration | 3210 (default) |
| ingress tunnel  | Native | Exposes local webhook endpoint           | -              |
| opencode server | Native | Agent execution backend                  | 4096           |

## Background Services

### macOS launchd (default path)

Use the built-in service manager instead of editing plist files by hand:

```bash
# Install/start webhook + managed OpenCode service for configured local URL
opencode-linear-agent setup

# Inspect launchd + configured OpenCode health
opencode-linear-agent status

# Inspect one service
opencode-linear-agent service status webhook
opencode-linear-agent service status opencode

# Stop or remove one service
opencode-linear-agent service stop webhook
opencode-linear-agent service uninstall webhook
opencode-linear-agent service stop opencode
opencode-linear-agent service uninstall opencode
```

Behavior:

- `setup` always installs/starts the per-user webhook launchd service on macOS.
- `setup` treats the configured `opencodeServerUrl` as the only OpenCode health check.
- If that configured URL is local `http://localhost:<port>` or `http://127.0.0.1:<port>` and unhealthy, `setup` installs/starts this tool's managed OpenCode launchd service for that exact endpoint.
- If `opencodeServerUrl` is non-local or non-HTTP, `setup` fails instead of guessing another server.
- Generated plist files live in `~/Library/LaunchAgents`.
- Service logs live in `$XDG_DATA_HOME/opencode-linear-agent/` (default `~/.local/share/opencode-linear-agent/`).

Managed files:

- `~/Library/LaunchAgents/com.opencode-linear-agent.server.plist`
- `~/Library/LaunchAgents/com.opencode-linear-agent.opencode.plist`
- `$XDG_DATA_HOME/opencode-linear-agent/launchd.log`
- `$XDG_DATA_HOME/opencode-linear-agent/launchd.err`
- `$XDG_DATA_HOME/opencode-linear-agent/opencode.launchd.log`
- `$XDG_DATA_HOME/opencode-linear-agent/opencode.launchd.err`

### Linux systemd (manual for now)

Linux automation is not built in yet. Use manual `systemd` if you want background startup:

Create `~/.config/systemd/user/opencode-linear-agent.service`:

```ini
[Unit]
Description=Linear OpenCode Agent webhook server
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/opencode-linear-agent
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

The app-managed webhook logs still land in `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/log/` as per-start files like `server-20260306T215717.187Z-p3210.log`. `StandardOutPath`, `StandardErrorPath`, `journalctl`, or terminal output only control extra stdout/stderr capture.

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
- Resolver maps to local path under `projectsPath`, ex: `repo:my-repo` -> `<projectsPath>/my-repo`.
- Missing/invalid `repo:*` blocks execution before worktree/session creation and posts an actionable error to Linear.

### Plan vs build mode

- Mode is selected from Linear issue **state type**:
  - `triage` or `backlog` -> `plan` mode
  - everything else (`unstarted`, `started`, `completed`, `canceled`) -> `build` mode
- `plan` mode: agent gets a small read-only mode reminder, then Linear's prompt context as-is.
- `build` mode: agent gets a small build-mode reminder, then Linear's prompt context as-is.
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
└── package.json
```

## Releases

- `latest` channel tracks `master` via `.github/workflows/release.yml`.
- Tagged releases (`v*`) publish to npm `stable` via `.github/workflows/release.yml`.
- Plugin package: `@opencode-linear-agent/plugin`.
- Server package: `@opencode-linear-agent/server`.
- Server npm installs pull a platform binary with no Bun runtime dependency.
- Server standalone binaries are also published via GitHub Releases.

## References

- Linear agents: https://linear.app/developers/agents
- Linear webhooks: https://linear.app/developers/webhooks
- OpenCode docs: https://opencode.ai/docs
