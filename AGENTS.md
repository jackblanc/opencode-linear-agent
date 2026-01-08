# Agent Guidelines for Linear OpenCode Agent

This document provides coding agents with essential information for working on this project.

## LLM-Friendly Documentation

When fetching external documentation, use LLM-optimized formats:

- **Linear**: Append `.md` to any Linear developer docs URL to get Markdown instead of HTML
  - Example: `https://linear.app/developers/webhooks` → `https://linear.app/developers/webhooks.md`
- **Cloudflare**: Append `index.md` to any Cloudflare docs section URL to get Markdown
  - Example: `https://developers.cloudflare.com/sandbox/` → `https://developers.cloudflare.com/sandbox/index.md`
- **OpenCode**: Documentation at `https://opencode.ai/docs/` returns Markdown automatically

---

## Project Overview

This is a Linear AI agent that integrates OpenCode (AI coding agent) to handle delegated issues. It supports two deployment modes:

1. **Cloudflare Workers** (production) - Uses Cloudflare Sandbox containers for isolated execution
2. **Local Docker Compose** (development) - Uses Docker containers with Tailscale Funnel for public webhook access

**Key Features:**

- Responds to Linear issue delegations and @mentions
- Streams real-time progress as Linear activities
- Creates isolated git worktrees per session
- Supports Claude Max OAuth for AI operations

**Stack**: TypeScript, Bun workspaces, Docker, Tailscale, Linear SDK, OpenCode SDK

---

## Architecture

### SSE-Based Event Handling

The project uses a pure SSE/SDK approach (no plugins):

```
┌──────────────────────────────────────────────────────────┐
│ Webhook Server (linear-webhook container)                │
│                                                          │
│  - Receives Linear webhooks                              │
│  - Verifies signatures + org ID                          │
│  - Creates git worktrees                                 │
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
```

### Security Layers

1. **Webhook signature verification** - Linear SDK verifies HMAC signatures
2. **Organization ID allowlist** - Rejects webhooks from other Linear orgs
3. **Tailscale Funnel** - Public endpoint only exposed via Tailscale (not raw internet)
4. **Session isolation** - Each session runs in its own git worktree

---

## Project Structure

```
linear-opencode-agent/
├── packages/
│   ├── core/                    # Platform-agnostic core logic
│   │   └── src/
│   │       ├── EventProcessor.ts      # Orchestrates webhook → session → SSE
│   │       ├── SSEEventHandler.ts     # Handles OpenCode SSE events
│   │       ├── session/
│   │       │   └── SessionManager.ts  # Session lifecycle management
│   │       ├── linear/
│   │       │   ├── LinearAdapter.ts   # Linear API interface
│   │       │   └── types.ts           # ActivityContent, PlanItem, etc.
│   │       └── webhook/
│   │           └── handlers.ts        # Webhook verification + dispatch
│   │
│   ├── local/                   # Local development server
│   │   ├── src/
│   │   │   ├── index.ts              # HTTP server + routing
│   │   │   ├── config.ts             # Configuration loader
│   │   │   └── git/
│   │   │       └── LocalGitOperations.ts  # Git worktree management
│   │   └── Dockerfile                # Bun-based webhook server image
│   │
│   ├── linear/                  # Cloudflare Worker entry point
│   ├── infrastructure/          # Cloudflare-specific implementations
│   └── agent/                   # Agent configuration
│
├── docker/
│   └── opencode/
│       └── Dockerfile           # OpenCode server image
│
├── docker-compose.yml           # Local development stack
├── tailscale-serve.json         # Tailscale Funnel config
├── config.docker.json           # Docker-specific config (gitignored secrets!)
├── .env                         # Environment variables (gitignored)
├── .env.example                 # Environment template
└── plan.md                      # Architecture migration plan
```

---

## Local Development with Docker Compose

### Prerequisites

- Docker & Docker Compose
- Tailscale account with Funnel enabled
- Linear OAuth app configured
- OpenCode with Claude Max OAuth (or Anthropic API key)

### Quick Start

1. **Copy environment template:**

   ```bash
   cp .env.example .env
   ```

2. **Configure `.env`:**

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...  # Or use Claude Max OAuth
   GITHUB_TOKEN=ghp_...
   REPO_PATH=~/projects/your-repo
   TS_AUTHKEY=tskey-auth-...     # From Tailscale admin console
   TAILSCALE_HOSTNAME=linear-agent
   ```

3. **Create `config.docker.json`** (copy from example and fill in Linear secrets):

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
     "repo": {
       "localPath": "/workspace/repo",
       "remoteUrl": "https://github.com/owner/repo"
     },
     "paths": {
       "worktrees": "/workspace/worktrees",
       "data": "/data"
     }
   }
   ```

4. **Start the stack:**

   ```bash
   docker compose up -d
   ```

5. **Copy OpenCode auth (for Claude Max):**

   ```bash
   docker compose cp ~/.local/share/opencode/auth.json opencode:/root/.local/share/opencode/auth.json
   docker compose restart opencode
   ```

6. **Get your public webhook URL:**

   ```bash
   docker compose exec tailscale tailscale funnel status
   ```

7. **Configure Linear webhook** to point to: `https://your-hostname.ts.net/webhook/linear`

### Container Architecture

| Container        | Purpose                         | Ports        |
| ---------------- | ------------------------------- | ------------ |
| `linear-webhook` | Webhook server, session manager | 3000 (local) |
| `opencode`       | AI coding agent                 | 4096 (local) |
| `tailscale`      | Exposes webhook via Funnel      | 443 (public) |

### Useful Commands

```bash
# View all logs
docker compose logs -f

# View specific container
docker compose logs -f linear-webhook

# Restart after config changes
docker compose restart linear-webhook

# Rebuild after code changes
docker compose up -d --build

# Connect to OpenCode TUI from host
opencode --remote http://localhost:4096

# Check Tailscale status
docker compose exec tailscale tailscale status
```

### Troubleshooting

**"Invalid webhook signature"**: Check `config.docker.json` has correct `webhookSecret` from Linear

**"Unauthorized organization"**: Verify `organizationId` matches your Linear workspace

**"ENOENT: git"**: Rebuild containers - `docker compose up -d --build`

**OpenCode auth expired**: Re-copy auth.json and restart:

```bash
docker compose cp ~/.local/share/opencode/auth.json opencode:/root/.local/share/opencode/auth.json
docker compose restart opencode
```

---

## Build, Lint & Test Commands

### Type Checking

```bash
bun run typecheck      # Run TypeScript type checking across all packages
```

### Linting

```bash
bun run lint:check     # Check for lint errors (oxlint)
bun run lint:fix       # Auto-fix lint errors
```

### Formatting

```bash
bun run format:check   # Check code formatting (prettier)
bun run format:fix     # Auto-fix formatting issues
```

### Combined Commands

```bash
bun run check          # Run typecheck + lint:check + format:check
bun run fix            # Run lint:fix + format:fix
```

### Deployment (Cloudflare Workers)

**Automatic**: Pushing to `master` triggers GitHub Actions to build and deploy automatically.

**Manual** (if needed):

```bash
bun run deploy         # Deploy to Cloudflare Workers
```

---

## Environment Variables

### Required for Local Development

| Variable       | Purpose                              | Example                   |
| -------------- | ------------------------------------ | ------------------------- |
| `REPO_PATH`    | Local path to repo for agent to work | `~/projects/reservations` |
| `TS_AUTHKEY`   | Tailscale auth key for Funnel        | `tskey-auth-...`          |
| `GITHUB_TOKEN` | Token for git operations             | `ghp_...`                 |

### Optional

| Variable             | Purpose                           | Example        |
| -------------------- | --------------------------------- | -------------- |
| `ANTHROPIC_API_KEY`  | API key (if not using Claude Max) | `sk-ant-...`   |
| `TAILSCALE_HOSTNAME` | Custom hostname for Funnel        | `linear-agent` |

### Config File Secrets (config.docker.json)

These are in the config file, not environment variables:

- `linear.clientId` - Linear OAuth app client ID
- `linear.clientSecret` - Linear OAuth app client secret
- `linear.webhookSecret` - Webhook signing secret from Linear
- `linear.organizationId` - Your Linear organization ID (for security)

---

## Code Style Guidelines

### TypeScript Configuration

- **Target**: ESNext
- **Module**: ESNext with bundler resolution
- **Strict mode**: Enabled
- **No emit**: True (base config, packages override)

### Linting Rules (oxlint)

The project uses oxlint with aggressive rules:

- `typescript: all` - All TypeScript rules enabled
- `correctness: all` - Correctness rules
- `suspicious: all` - Suspicious code patterns
- `perf: all` - Performance rules

### Naming Conventions

- **Variables & Functions**: camelCase
- **Types & Interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE (for true constants)
- **Files**: kebab-case for new files

### Error Handling

- Always handle errors in async operations
- Use structured error responses: `Response.json({ error: "..." }, { status: 400 })`
- Avoid throwing unhandled errors in fetch handlers

---

## Pre-Commit Checklist

Before committing changes, ensure:

1. `bun run check` passes (typecheck + lint + format)
2. No secrets in committed files (check `config.docker.json` is gitignored)
3. Docker containers still work: `docker compose up -d --build`

---

## External References

All external documentation should be fetched in LLM-friendly formats.

### Linear Documentation

**Agents:**

- https://linear.app/developers/agents.md - Agent overview
- https://linear.app/developers/aig.md - Agent implementation guide
- https://linear.app/developers/agent-interaction.md - Agent interaction patterns
- https://linear.app/developers/agent-best-practices.md - Best practices for agents
- https://linear.app/developers/agent-signals.md - Agent signals reference

**OAuth:**

- https://linear.app/developers/oauth-2-0-authentication.md - OAuth 2.0 authentication
- https://linear.app/developers/oauth-actor-authorization.md - Actor authorization

**Webhooks:**

- https://linear.app/developers/webhooks.md - Webhooks overview
- https://linear.app/developers/sdk-webhooks.md - SDK webhook handling

### Cloudflare Documentation

- https://developers.cloudflare.com/llms.txt - Documentation directory
- https://developers.cloudflare.com/workers/prompt.txt - Workers guide for LLMs
- https://developers.cloudflare.com/sandbox/index.md - Sandbox SDK

### OpenCode Documentation

- https://opencode.ai/docs/sdk/ - OpenCode SDK
- https://opencode.ai/docs/server/ - OpenCode Server
- https://opencode.ai/docs/providers/ - Provider configuration (Claude Max, etc.)
