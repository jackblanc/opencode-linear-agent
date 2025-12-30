# Agent Guidelines for Linear OpenCode Agent

This document provides coding agents with essential information for working on this Cloudflare Workers + OpenCode project.

## Project Overview

This is a Cloudflare Worker that integrates OpenCode (AI coding agent) with Cloudflare's Sandbox SDK, providing:

- OpenCode Web UI for interactive AI-powered coding (protected by API key)
- Programmatic API for session management
- Secure, isolated code execution environment via Cloudflare Sandbox containers
- Linear integration via webhook handling and plugin

**Stack**: TypeScript, Cloudflare Workers, Durable Objects, Sandbox containers, Bun workspaces

---

## Project Structure

```
linear-opencode-agent/
├── packages/
│   ├── worker/                              # Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts                    # Request routing, auth checks
│   │   │   ├── auth.ts                     # API key validation helper
│   │   │   ├── oauth.ts                    # Linear OAuth flow
│   │   │   ├── webhook.ts                  # Linear webhook handler
│   │   │   └── config.ts                   # OpenCode configuration
│   │   ├── Dockerfile                      # Sandbox container with plugin
│   │   ├── wrangler.jsonc                  # Cloudflare Workers config
│   │   ├── package.json                    # Worker dependencies
│   │   ├── tsconfig.json                   # Extends root config
│   │   └── worker-configuration.d.ts       # Generated Cloudflare types
│   │
│   └── opencode-linear-agent/              # Plugin package
│       ├── src/
│       │   └── index.ts                    # Plugin using @linear/sdk
│       ├── dist/                           # Build output (gitignored)
│       ├── package.json                    # Plugin dependencies
│       └── tsconfig.json                   # Extends root config
│
├── package.json                            # Root workspace configuration
├── tsconfig.json                           # Base TypeScript configuration
├── bun.lock
├── .gitignore
├── .dev.vars.example                       # Environment variable template
├── AGENTS.md                               # This file
├── PLAN.md                                 # Implementation plan
└── README.md
```

---

## Build, Lint & Test Commands

### Development

```bash
bun install            # Install all workspace dependencies
bun run dev            # Start local dev server (builds Docker on first run)
```

### Building

```bash
bun run build          # Build the plugin package
```

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

### Deployment

```bash
bun run deploy         # Build plugin and deploy to Cloudflare Workers
```

### Package-specific commands

```bash
bun run --filter @linear-opencode-agent/worker dev       # Run worker dev server
bun run --filter @linear-opencode-agent/worker deploy    # Deploy worker only
bun run --filter opencode-linear-agent build             # Build plugin only
```

---

## Environment Variables

### Required Variables

| Variable                | Purpose                                  | Example                         |
| ----------------------- | ---------------------------------------- | ------------------------------- |
| `ANTHROPIC_API_KEY`     | API key for OpenCode AI operations       | `sk-ant-...`                    |
| `LINEAR_CLIENT_ID`      | Linear OAuth app client ID               | `lin_api_...`                   |
| `LINEAR_CLIENT_SECRET`  | Linear OAuth app client secret           | `lin_api_...`                   |
| `LINEAR_WEBHOOK_SECRET` | Webhook signing secret from Linear       | `...`                           |
| `GITHUB_TOKEN`          | Token for cloning repositories           | `ghp_...`                       |
| `ADMIN_API_KEY`         | Protects OpenCode UI and admin endpoints | `sk-admin-xxxxxxxxxxxx`         |
| `REPO_URL`              | Repository the agent works on            | `https://github.com/owner/repo` |

### Local Development

Create a `.dev.vars` file in the `packages/worker/` directory (or root) with your secrets.

### Production

Set secrets via wrangler:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_API_KEY
wrangler secret put REPO_URL
# ... etc
```

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

### Imports & Module Organization

**Import order** (follow existing patterns):

1. External packages (e.g., `@cloudflare/sandbox`)
2. Specific named imports grouped logically
3. Type imports using `import type`
4. Re-exports at module boundaries

**Example**:

```typescript
import { getSandbox } from "@cloudflare/sandbox";
import {
  createOpencodeServer,
  proxyToOpencode,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";

export { Sandbox } from "@cloudflare/sandbox";
```

### Naming Conventions

- **Variables & Functions**: camelCase
- **Types & Interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE (for true constants)
- **Files**: kebab-case for new files

### Error Handling

- Always handle errors in async operations
- Use structured error responses: `Response.json({ error: "..." }, { status: 400 })`
- Avoid throwing unhandled errors in Worker fetch handlers

---

## API Endpoints

### Public Endpoints

| Endpoint           | Method | Description                         |
| ------------------ | ------ | ----------------------------------- |
| `/health`          | GET    | Health check                        |
| `/oauth/authorize` | GET    | Start Linear OAuth flow             |
| `/oauth/callback`  | GET    | OAuth redirect (CSRF protected)     |
| `/webhook/linear`  | POST   | Linear webhook (signature verified) |

### Protected Endpoints (require `?key=ADMIN_API_KEY`)

| Endpoint     | Method | Description        |
| ------------ | ------ | ------------------ |
| `/`          | GET    | Info page          |
| `/opencode`  | GET    | OpenCode Web UI    |
| `/session/*` | \*     | Session management |
| `/event/*`   | \*     | Event streaming    |

---

## Common Tasks

### Adding a new endpoint

1. Add route logic in `packages/worker/src/index.ts` fetch handler
2. Parse URL pathname: `const url = new URL(request.url)`
3. Add auth check if needed: `if (!validateApiKey(request, env)) return unauthorizedResponse()`
4. Return appropriate Response object
5. Run `bun run check` before committing

### Updating the plugin

1. Edit `packages/opencode-linear-agent/src/index.ts`
2. Run `bun run build` to rebuild
3. Test locally with `bun run dev`

### Regenerating Cloudflare types

```bash
cd packages/worker && bun run cf-typegen
```

---

## Pre-Commit Checklist

Before committing changes, ensure:

1. `bun run typecheck` passes
2. `bun run lint:check` passes
3. `bun run format:check` passes
4. No secrets in `.dev.vars` (should be gitignored)
5. Plugin is built if changed: `bun run build`

Or simply run:

```bash
bun run check  # Runs all three checks
```

---

## Troubleshooting

**Type errors**: Run `cd packages/worker && bun run cf-typegen` to regenerate types
**Lint errors**: Run `bun run lint:fix` to auto-fix
**Format errors**: Run `bun run format:fix` to auto-format
**Container build slow**: First run builds Docker image (2-3 min), subsequent runs are fast
**Dev server issues**: Check `.dev.vars` exists with all required variables
**Plugin not updating**: Ensure you run `bun run build` after plugin changes

---

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [OpenCode Documentation](https://opencode.ai/docs)
- [Linear SDK](https://developers.linear.app/docs/sdk/getting-started)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
