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

This is a Linear AI agent that integrates OpenCode to handle delegated issues. It supports two deployment modes:

1. **Local Docker Compose** (development) - Uses Docker containers with Cloudflare Tunnel for public webhook access
2. **Cloudflare Workers** (production) - Uses Cloudflare Sandbox containers for isolated execution

**Key Features:**

- Responds to Linear issue delegations and @mentions
- Streams real-time progress as Linear activities
- Resolves repository from GitHub links in issues
- Creates isolated git worktrees per session
- Uses OAuth for both Claude Max and Linear MCP (no API keys)
- IP allowlisting via Cloudflare Access for webhook security

**Stack**: TypeScript, Bun workspaces, Docker, Cloudflare Tunnel, Linear SDK, OpenCode SDK

---

## Architecture

### SSE-Based Event Handling

The project uses a pure SSE/SDK approach (no plugins):

```
┌──────────────────────────────────────────────────────────┐
│ Webhook Server (webhook-server container)                │
│                                                          │
│  - Receives Linear webhooks                              │
│  - Verifies signatures + org ID                          │
│  - Resolves repo from issue GitHub links                 │
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

### Container Paths

The opencode container is a pass-through to the host - it mounts your local projects, config, and auth directly:

| Container Path                     | Host Path                 | Purpose                  |
| ---------------------------------- | ------------------------- | ------------------------ |
| `/home/user/projects`              | `~/projects`              | Your repositories        |
| `/home/user/opencode-worktrees`    | `~/opencode-worktrees`    | Session worktrees        |
| `/home/user/.config/opencode`      | `~/.config/opencode`      | OpenCode config          |
| `/home/user/.local/share/opencode` | `~/.local/share/opencode` | Auth, logs (no copying!) |
| `/home/user/.ssh`                  | `~/.ssh`                  | SSH keys for git         |

### Security Layers

1. **Webhook signature verification** - Linear SDK verifies HMAC signatures
2. **Organization ID allowlist** - Rejects webhooks from other Linear orgs
3. **Cloudflare Tunnel + Access** - Public endpoint with IP allowlisting restricted to Linear's webhook IPs
4. **Session isolation** - Each session runs in its own git worktree

**Linear Webhook IP Addresses** (for Cloudflare Access allowlist):

- 35.231.147.226
- 35.243.134.228
- 34.140.253.14
- 34.38.87.206
- 34.134.222.122
- 35.222.25.142

_Note: Linear may update this list occasionally. Check [Linear's webhook documentation](https://linear.app/developers/webhooks) for updates._

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
│   ├── server/                  # Webhook server (formerly local)
│   │   ├── src/
│   │   │   ├── index.ts              # HTTP server + routing
│   │   │   ├── config.ts             # Configuration loader
│   │   │   ├── RepoResolver.ts       # Resolve repo from GitHub links
│   │   │   ├── RepoDiscovery.ts      # Auto-discover repos from mounted directories
│   │   │   └── storage/              # File-based storage for tokens and sessions
│   │   ├── Dockerfile               # Bun-based webhook server image
│   │   ├── config.example.json      # Example config file
│   │   └── config.json              # Docker config (gitignored)
│   │
│   ├── opencode/                # OpenCode container environment
│   │   └── Dockerfile           # Ubuntu-based image with dev tools
│   │
│   └── agent/                   # (DEPRECATED: Cloudflare Workers entry point removed)
│       └── ...                  # Deleted in favor of two-container architecture
│
├── docker-compose.yml           # Local development stack
├── cloudflare-tunnel-setup.md   # Guide for setting up Cloudflare Tunnel
├── config.docker.json           # Docker-specific config (gitignored secrets!)
├── .env                         # Environment variables (gitignored)
└── .env.example                 # Environment template
```

---

## Local Development with Docker Compose

### Prerequisites

- Docker & Docker Compose
- Cloudflare account with a domain managed by Cloudflare
- `cloudflared` CLI installed locally
- Linear OAuth app configured
- OpenCode with Claude Max OAuth authenticated locally

### Quick Start

1. **Copy environment template:**

   ```bash
   cp .env.example .env
   ```

2. **Set up Cloudflare Tunnel:**

   Follow the detailed guide in [cloudflare-tunnel-setup.md](./cloudflare-tunnel-setup.md) to:
   - Create a Cloudflare Tunnel
   - Get your tunnel token
   - Configure Cloudflare Access with Linear's IP allowlist

3. **Configure `.env`:**

   ```bash
   GITHUB_TOKEN=ghp_...
   TUNNEL_TOKEN=eyJhIjoiY...     # From Cloudflare Tunnel setup
   ```

4. **Create `config.docker.json`** with Linear secrets (repos are auto-discovered):

   ```json
   {
     "port": 3000,
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

6. **Ensure you have an AGENTS.md file:**

   The container mounts your local OpenCode config from `~/.config/opencode/`. Make sure you have:
   - `~/.config/opencode/opencode.json` - Your OpenCode configuration
   - `~/.config/opencode/AGENTS.md` - Your agent instructions

   If you don't have these, the container will use fallback defaults from `packages/opencode/`.

7. **Build and start the stack:**

   ```bash
   docker compose build
   docker compose up -d
   ```

8. **Configure Linear webhook** to point to your Cloudflare Tunnel URL (e.g., `https://linear-agent.yourdomain.com/webhook/linear`)

### Container Architecture

| Container        | Purpose                         | Ports           |
| ---------------- | ------------------------------- | --------------- |
| `webhook-server` | Webhook server, session manager | 3000 (local)    |
| `opencode`       | AI coding agent                 | 4096 (internal) |
| `cloudflared`    | Exposes webhook via tunnel      | N/A (outbound)  |

### Useful Commands

```bash
# Rebuild containers after code changes
docker compose build
docker compose up -d

# View all logs
docker compose logs -f

# View specific container
docker compose logs -f webhook-server

# Restart after config changes
docker compose restart webhook-server

# Check Cloudflare Tunnel status
docker compose logs cloudflared
```

### Troubleshooting

**"Invalid webhook signature"**: Check `config.docker.json` has correct `webhookSecret` from Linear

**"Unauthorized organization"**: Verify `organizationId` matches your Linear workspace

**"ENOENT: git"**: Rebuild containers - `docker compose build && docker compose up -d`

**OpenCode auth expired**: Re-authenticate on host (container uses host auth directly):

```bash
opencode                    # Re-authenticate Claude Max
opencode mcp auth linear    # Re-authenticate Linear MCP
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

| Variable       | Purpose                  | Example        |
| -------------- | ------------------------ | -------------- |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token  | `eyJhIjoiY...` |
| `GITHUB_TOKEN` | Token for git operations | `ghp_...`      |

### Optional

| Variable            | Purpose                           | Example      |
| ------------------- | --------------------------------- | ------------ |
| `ANTHROPIC_API_KEY` | API key (if not using Claude Max) | `sk-ant-...` |

### Config File Secrets (config.docker.json)

These are in the config file, not environment variables:

- `linear.clientId` - Linear OAuth app client ID
- `linear.clientSecret` - Linear OAuth app client secret
- `linear.webhookSecret` - Webhook signing secret from Linear
- `linear.organizationId` - Your Linear organization ID (for security)

---

## Code Style Guidelines

### General Principles

- Try to keep things in one function unless composable or reusable
- AVOID unnecessary destructuring of variables - instead of `const { a, b } = obj` just reference `obj.a` and `obj.b` (preserves context)
- AVOID `try`/`catch` blocks unless absolutely necessary
- AVOID `else` statements
- AVOID using `any` type
- AVOID `let` statements - prefer `const`
- PREFER single word variable names where possible
- Use Bun APIs where available (e.g., `Bun.file()`)

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

**NEVER use `try`/`catch` blocks unless absolutely necessary.**

#### OpenCode SDK Error Handling

The OpenCode SDK uses `throwOnError: false` by default, meaning errors are returned as part of the response object rather than thrown. **Do NOT wrap SDK calls in try/catch.**

```typescript
// CORRECT - check the error field
const result = await client.session.get({ path: { id: sessionId } });
if (result.error) {
  console.error("Failed to get session:", result.error);
  return;
}
console.log("Session:", result.data);

// WRONG - unnecessary try/catch
try {
  const result = await client.session.get({ path: { id: sessionId } });
} catch (error) {
  // This will never catch SDK errors with default config!
}
```

The response shape is:

```typescript
{
  data: T | undefined,
  error: TError | undefined,
  request: Request,
  response: Response
}
```

#### Message-Level Errors

For assistant messages, errors are embedded in `AssistantMessage.error`:

| Error Type                 | Description                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `ProviderAuthError`        | Authentication failed with the LLM provider                         |
| `UnknownError`             | Generic unexpected error                                            |
| `MessageOutputLengthError` | Response exceeded output token limit                                |
| `MessageAbortedError`      | Message generation was cancelled                                    |
| `APIError`                 | HTTP/API error from provider (includes `statusCode`, `isRetryable`) |

```typescript
const result = await client.session.prompt({
  path: { id: session.id },
  body: { parts: [{ type: "text", text: "Hello!" }] },
});

if (result.data?.error) {
  if (
    result.data.error.name === "APIError" &&
    result.data.error.data.isRetryable
  ) {
    // Handle retryable error
  }
}
```

#### HTTP Response Errors

For HTTP handlers, use structured error responses:

```typescript
// Return error responses, don't throw
if (!request.valid) {
  return Response.json({ error: "Invalid request" }, { status: 400 });
}
```

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
