# Agent Guidelines for Linear OpenCode Agent

This document provides coding agents with essential information for working on this Cloudflare Workers + OpenCode project.

## Project Overview

This is a Cloudflare Worker that integrates OpenCode (AI coding agent) with Cloudflare's Sandbox SDK, providing:
- OpenCode Web UI for interactive AI-powered coding
- Programmatic API for session management
- Secure, isolated code execution environment via Cloudflare Sandbox containers
- Linear integration capabilities (planned)

**Stack**: TypeScript, Cloudflare Workers, Durable Objects, Sandbox containers, Bun runtime

---

## Build, Lint & Test Commands

### Development
```bash
bun run dev           # Start local dev server (builds Docker on first run)
bun run start         # Alias for dev
```

### Type Checking
```bash
bun run typecheck     # Run TypeScript type checking
bun run cf-typegen    # Generate Cloudflare types from wrangler config
```

### Linting
```bash
bun run lint:check    # Check for lint errors (oxlint)
bun run lint:fix      # Auto-fix lint errors
```

### Formatting
```bash
bun run format:check  # Check code formatting (prettier)
bun run format:fix    # Auto-fix formatting issues
```

### Combined Commands
```bash
bun run check         # Run typecheck + lint:check + format:check
bun run fix           # Run lint:fix + format:fix
```

### Deployment
```bash
bun run deploy        # Deploy to Cloudflare Workers
```

### Testing
**Note**: This project currently has no test suite configured. Tests should be added using a framework compatible with Bun (e.g., Bun's built-in test runner).

To run a single test (when implemented):
```bash
bun test path/to/test.test.ts
```

---

## Code Style Guidelines

### TypeScript Configuration
- **Target**: ESNext
- **Module**: ESNext with bundler resolution
- **Strict mode**: Enabled
- **No emit**: True (type checking only)

### Linting Rules (oxlint)
The project uses oxlint with aggressive rules:
- `typescript: all` - All TypeScript rules enabled
- `correctness: all` - Correctness rules
- `suspicious: all` - Suspicious code patterns
- `perf: all` - Performance rules

**Key implications**:
- No unused variables
- Strict null checks
- No type assertions without justification
- Prefer const over let where possible

### Imports & Module Organization

**Import order** (follow existing patterns in `src/index.ts`):
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
  createOpencode,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";

export { Sandbox } from "@cloudflare/sandbox";
```

### Formatting (Prettier)
- Managed by `.prettierignore` (excludes node_modules, dist, build, .wrangler, lock files)
- Always run `bun run format:fix` before committing

### Naming Conventions

**Variables & Functions**: camelCase
```typescript
const sandboxInstance = getSandbox(env.Sandbox, "linear-opencode-agent");
async function createSession() { ... }
```

**Types & Interfaces**: PascalCase
```typescript
interface OpencodeClient { ... }
type ExportedHandlerFetchHandler<Env = unknown> = ...
```

**Constants**: UPPER_SNAKE_CASE (for true constants)
```typescript
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
```

**Files**: kebab-case for new files
```typescript
// Good: opencode-agent.ts, linear-client.ts
// Avoid: OpencodeAgent.ts, opencode_agent.ts
```

### Type Annotations

**Explicit return types** on exported functions:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ...
  }
}
```

**Use type imports** where possible:
```typescript
import type { OpencodeClient } from "@opencode-ai/sdk";
```

**Avoid `any`** - use `unknown` or proper typing:
```typescript
// Bad
function process(data: any) { ... }

// Good
function process(data: unknown) { ... }
function process<T>(data: T) { ... }
```

### Error Handling

**Always handle errors in async operations**:
```typescript
if (!session.data) {
  return Response.json(
    { error: "Failed to create session" },
    { status: 500 },
  );
}
```

**Use structured error responses**:
```typescript
return Response.json(
  { error: "Descriptive error message" },
  { status: 400 },
);
```

**Avoid throwing unhandled errors** in Worker fetch handlers - return error responses instead.

### Environment Variables

**Access via typed `Env` interface**:
```typescript
interface Env {
  Sandbox: DurableObjectNamespace<import("./src/index").Sandbox>;
  ANTHROPIC_API_KEY: string;
}

// Usage
const apiKey = env.ANTHROPIC_API_KEY;
```

**Local development**: Use `.dev.vars` (never commit secrets)
**Production**: Set via `wrangler secret put VARIABLE_NAME`

### Response Patterns

**JSON responses**:
```typescript
return Response.json({ key: "value" });
```

**Text responses**:
```typescript
return new Response("Plain text content");
```

**With status codes**:
```typescript
return Response.json({ error: "Not found" }, { status: 404 });
```

### Async/Await
- Prefer `async/await` over raw Promises
- Always await async operations in Workers (no fire-and-forget)
- Use `ctx.waitUntil()` for background operations

### Comments
- Use JSDoc for exported functions/types
- Inline comments for complex logic only
- Avoid obvious comments - code should be self-documenting

---

## Project-Specific Patterns

### Cloudflare Workers Handler
The main export is a `fetch` handler:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Route handling logic
  }
}
```

### Sandbox Usage
```typescript
const sandbox = getSandbox(env.Sandbox, "unique-sandbox-id");
await sandbox.exec("command");
await sandbox.writeFile("/path", "content");
const file = await sandbox.readFile("/path");
```

### OpenCode Integration
```typescript
// Web UI (proxy approach)
const server = await createOpencodeServer(sandbox, { ... });
return proxyToOpencode(request, sandbox, server);

// Programmatic SDK
const { client } = await createOpencode<OpencodeClient>(sandbox, { ... });
const session = await client.session.create({ body: { title: "..." } });
```

---

## File Structure

```
.
├── src/
│   └── index.ts              # Main Worker with OpenCode integration
├── Dockerfile                # OpenCode-enabled Sandbox container
├── wrangler.jsonc            # Cloudflare Workers config
├── tsconfig.json             # TypeScript configuration
├── oxlintrc.json             # Linting rules
├── package.json              # Dependencies & scripts
├── .dev.vars.example         # Environment variable template
└── worker-configuration.d.ts # Generated Cloudflare types
```

---

## Common Tasks

### Adding a new endpoint
1. Add route logic in `src/index.ts` fetch handler
2. Parse URL pathname: `const url = new URL(request.url)`
3. Return appropriate Response object
4. Run `bun run check` before committing

### Updating dependencies
```bash
bun update
# Update Dockerfile to match sandbox version if needed
```

### Regenerating types
```bash
bun run cf-typegen  # Updates worker-configuration.d.ts
```

---

## Pre-Commit Checklist

Before committing changes, ensure:
1. ✅ `bun run typecheck` passes
2. ✅ `bun run lint:check` passes
3. ✅ `bun run format:check` passes
4. ✅ No secrets in `.dev.vars` (should be gitignored)
5. ✅ Update Dockerfile version if dependencies changed

Or simply run:
```bash
bun run check  # Runs all three checks
```

---

## Troubleshooting

**Type errors**: Run `bun run cf-typegen` to regenerate types
**Lint errors**: Run `bun run lint:fix` to auto-fix
**Format errors**: Run `bun run format:fix` to auto-format
**Container build slow**: First run builds Docker image (2-3 min), subsequent runs are fast
**Dev server issues**: Check `.dev.vars` exists with valid `ANTHROPIC_API_KEY`

---

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [OpenCode Documentation](https://opencode.ai/docs)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
