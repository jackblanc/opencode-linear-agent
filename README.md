# Linear OpenCode Agent

Self-hosted Linear coding agent powered by OpenCode.

> [!WARNING]
> Alpha software. Self-hosted only. Breaking changes may ship without migration support.

## What You Install

- `@opencode-linear-agent/server`: local webhook/OAuth server
- `@opencode-linear-agent/plugin`: OpenCode plugin that streams agent activity back to Linear

Both must run on the same machine because they share state via the filesystem.

## Prerequisites

- A public HTTPS hostname that can reach your local agent server
- OpenCode installed locally
- Linear workspace admin access to create an OAuth app and webhook

## 1. Install The Server

```bash
npm i -g @opencode-linear-agent/server
```

This installs `opencode-linear-agent` plus the matching native runtime for your platform. Supported runtimes: macOS/Linux, `arm64` and `x64`.

## 2. Configure OpenCode

Update your global OpenCode config file (default: `~/.config/opencode/opencode.json`)

The plugin `@opencode-linear-agent/plugin@latest` is required to stream agent activity back to Linear

The MCP is recommended, but optional. You can authenticate with the MCP normally, or reuse the server's access token, so that actions taken by the agent show as coming from the "OpenCode Agent" actor.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opencode-linear-agent/plugin@latest"],
  "mcp": {
    // Option 1: normal MCP setup, your user account is the actor
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/mcp",
      "enabled": true,
    }

    // Option 2: use server's OAuth token, your "OpenCode Agent" app is the actor
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        // Default: ~/.local/share/opencode-linear-agent/oauth_access_token.txt
        // If XDG_DATA_HOME is set, use "Bearer {file:{env:XDG_DATA_HOME}/opencode-linear-agent/oauth_access_token.txt
        "Authorization": "Bearer {file:~/.local/share/opencode-linear-agent/oauth_access_token.txt}"
      }
    }
  }
}
```

## 3. Create The Linear App And Webhook

Open:

`https://linear.app/settings/api/applications/new`

Then:

1. Set redirect URI to `https://<public-hostname>/api/oauth/callback`
2. Enable scopes:
   - `write`
   - `app:mentionable`
   - `app:assignable`
3. Set webhook URL to `https://<public-hostname>/api/webhook/linear`
4. Subscribe the webhook to:
   - `AgentSessionEvent`
   - `Issue`
5. Copy values for `config.json`:
   - Client ID -> `linearClientId`
   - Client Secret -> `linearClientSecret`
   - Webhook secret -> `linearWebhookSecret`

To fetch your organization id:

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer <LINEAR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ organization { id name } }"}'
```

Use `organization.id` as `linearOrganizationId`.

## 4. Create Agent Config

Create `~/.config/opencode-linear-agent/config.json`

```json
{
  "webhookServerPublicHostname": "your-hostname.example.com",
  "webhookServerPort": 3210,
  "opencodeServerUrl": "http://localhost:4096",
  "linearOrganizationId": "<linear-organization-id>",
  "linearClientId": "<linear-client-id>",
  "linearClientSecret": "<linear-client-secret>",
  "linearWebhookSecret": "<linear-webhook-secret>"
}
```

## 5. Expose The Local Server Over HTTPS

Your public hostname must forward to local port `3210` or your configured `webhookServerPort`.

Options:

- Cloudflare Tunnel: see `docs/cloudflare-tunnel-setup.md`
- ngrok

```bash
ngrok http 3210
```

- Tailscale Funnel

```bash
tailscale funnel 3210
```

Set `webhookServerPublicHostname` to the hostname provided by your tunnel.

## 6. Start OpenCode

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

If you use a different host or port, update `opencodeServerUrl`.

OpenCode must already know about the repositories you want the agent to work in.

## 7. Start The Agent Server

```bash
opencode-linear-agent
```

The startup banner prints:

- local server URL
- webhook URL
- OAuth URL

Open the printed OAuth URL once to install the app into Linear.

## Usage

1. Create a Linear issue
2. Delegate it to your agent user
3. Optionally add a `repo:<name>` label
4. The agent will match that label to an existing OpenCode project

If the repo label is missing, invalid, or does not match an OpenCode project, the agent asks you to choose a project in Linear.

Issues in `triage` or `backlog` run in plan mode. Other issue states run in build mode. In build mode, an `unstarted` issue is automatically moved to the first workflow state of type `started`.

When an issue is completed or canceled, the agent attempts to abort the OpenCode session, remove the worktree, and clean up local session state.

## Files And Logs

- Config: `${XDG_CONFIG_HOME:-$HOME/.config}/opencode-linear-agent/config.json`
- Shared state root: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/state`
- OAuth access token mirror: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-linear-agent/oauth_access_token.txt`
- Server logs: stderr/stdout of the running process

## Running In Background

### macOS launchd

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
    <string>/Users/you/.local/bin/opencode-linear-agent</string>
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

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.opencode-linear-agent.server.plist
launchctl start com.opencode-linear-agent.server
```

### Linux systemd

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

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-linear-agent.service
journalctl --user -u opencode-linear-agent.service -f
```

The agent writes logs to stderr/stdout. Use launchd, systemd, journalctl, or shell redirection to persist them.

## References

- Linear agents: https://linear.app/developers/agents
- Linear webhooks: https://linear.app/developers/webhooks
- OpenCode docs: https://opencode.ai/docs
