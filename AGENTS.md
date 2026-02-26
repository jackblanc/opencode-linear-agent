# Agent Guidelines for Linear OpenCode Agent

## Build, Lint & Test Commands

```bash
# Type checking
bun run typecheck              # Check all packages

# Linting (oxlint)
bun run lint:check             # Check for lint errors
bun run lint:fix               # Auto-fix lint errors

# Formatting (prettier)
bun run format:check           # Check formatting
bun run format:fix             # Auto-fix formatting

# Dead code detection
bun run knip                   # Find unused exports/dependencies

# All checks (pre-commit)
bun run check                  # typecheck + lint + format + knip + test
bun run fix                    # lint:fix + format:fix
```

---

## Local Development

### Services

You need two always-on services:

- webhook server (`bun run start`)
- OpenCode server (`opencode serve --port 4096 --hostname 127.0.0.1`)

### Key Paths

| Path                                               | Purpose                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `~/.local/share/linear-opencode-agent/store.json`  | Session state, tokens, pending questions/permissions |
| `~/.local/share/linear-opencode-agent/launchd.log` | Webhook server stdout                                |
| `~/.local/share/linear-opencode-agent/launchd.err` | Webhook server stderr                                |
| `~/.local/share/opencode/worktree/`                | Git worktrees created by OpenCode                    |
| `~/.config/opencode/plugin/linear.js`              | Optional built plugin file                           |

### Plugin Development

```bash
# Build plugin bundle
bun run --filter @linear-opencode-agent/plugin build

# Install plugin for local OpenCode
mkdir -p ~/.config/opencode/plugin
cp packages/plugin/dist/index.js ~/.config/opencode/plugin/linear.js
```

Restart OpenCode after plugin changes.

### Triggering Agent Sessions

- Delegate issue to OpenCode Agent in Linear (needs `repo:X` label)
- Or mention the agent in a comment on an issue with active session
- Re-delegating to same agent does not emit a new webhook

### Running Tests

```bash
bun test                              # Run all tests
bun test packages/core                # Run tests in a package
bun test packages/core/test/handlers  # Run tests in a directory
bun test path/to/file.test.ts         # Run single test file
bun test --filter "pattern"           # Run tests matching pattern
```

---

## Project-Specific Style

### Naming Conventions

| Type             | Convention               | Example                                          |
| ---------------- | ------------------------ | ------------------------------------------------ |
| Event Processors | `{Source}EventProcessor` | `LinearEventProcessor`, `OpencodeEventProcessor` |
| Handlers         | `{EventType}Handler`     | `ToolHandler`, `TextHandler`                     |
| Managers         | `{Concern}Manager`       | `SessionManager`, `WorktreeManager`              |
| Services         | `{Thing}Service`         | `LinearService`, `OpencodeService`               |
| Errors           | `{Source}{Type}Error`    | `LinearAuthError`, `OpencodeApiError`            |

### Import Conventions

```typescript
// Type imports - use `import type` (enforced by oxlint)
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";

// Node builtins - use node: prefix (enforced by oxlint)
import { join } from "node:path";

// Workspace packages
import { LinearEventProcessor } from "@linear-opencode-agent/core";
```

### TypeScript Rules (enforced by oxlint)

- `typescript/explicit-function-return-type` - All functions need return types
- `typescript/no-non-null-assertion` - No `!` assertions
- `typescript/consistent-type-imports` - Use `import type` for types
- `typescript/switch-exhaustiveness-check` - Switch must be exhaustive
- `eslint/no-console` - No console.log (use structured logging)
- `unicorn/prefer-node-protocol` - Use `node:` prefix for builtins

---

## Project Structure

```
packages/
├── core/           # Platform-agnostic business logic
│   └── src/
│       ├── actions/    # Action types (LinearAction, OpencodeAction) and executor
│       ├── errors/     # Tagged error types (LinearServiceError, OpencodeServiceError)
│       ├── handlers/   # Pure handler functions (ToolHandler, TextHandler, TodoHandler)
│       ├── linear/     # LinearService interface and LinearServiceImpl
│       ├── opencode/   # OpencodeService wrapper around @opencode-ai/sdk
│       ├── session/    # SessionState type and SessionRepository interface
│       └── webhook/    # Webhook signature verification and dispatch
├── server/         # Webhook server (Bun) - receives Linear webhooks
└── plugin/         # OpenCode plugin - hooks into OpenCode events, posts to Linear
```

---

## Architecture: Event Processing

This agent processes events from two sources and posts actions to two targets:

```
Linear Webhooks ──► LinearEventProcessor ──► Actions ──► LinearService
                                                    └──► OpencodeService

OpenCode SSE ────► OpencodeEventProcessor ─► Actions ──► LinearService
                                                    └──► OpencodeService
```

### Functional State Management

**Core principle:** Processing is stateless. Pure functions receive state, return new state + actions.

```typescript
// Pure function - no side effects, no I/O
function processToolPart(
  part: ToolPart,
  state: SessionState
): { state: SessionState; actions: Action[] } {
  if (state.runningTools.has(part.id)) {
    return { state, actions: [] };
  }
  return {
    state: { ...state, runningTools: new Set([...state.runningTools, part.id]) },
    actions: [{ type: "postActivity", content: {...} }],
  };
}

// Orchestrator handles I/O
async function handleEvent(event: Event): Promise<void> {
  const state = await repository.get(sessionId);
  const { state: newState, actions } = processToolPart(event, state);
  await executeActions(actions);
  await repository.save(newState);
}
```

### Tagged Errors

All errors extend `TaggedError` with a `_tag` discriminator for exhaustive matching:

```typescript
import { TaggedError } from "better-result";

export class LinearNotFoundError extends TaggedError("LinearNotFoundError")<{
  resourceType: string;
  resourceId: string;
  message: string;
}>() {}

export type LinearServiceError =
  | LinearNotFoundError
  | LinearAuthError
  | LinearRateLimitError
  | LinearForbiddenError
  | LinearNetworkError;
```

### Error Categories

| Category        | Examples                       | Action                       |
| --------------- | ------------------------------ | ---------------------------- |
| **Fatal**       | Auth failures, missing repo    | Post to Linear, early return |
| **Recoverable** | Activity posting, plan updates | Log, continue processing     |
| **Retryable**   | Rate limits, network timeouts  | Log, retry if applicable     |

```typescript
// Fatal - can't proceed
const worktreeResult = await this.opencode.createWorktree(...);
if (Result.isError(worktreeResult)) {
  await this.linear.postError(sessionId, worktreeResult.error);
  return;  // Early return
}

// Recoverable - log and continue
const activityResult = await this.linear.postActivity(sessionId, content);
if (Result.isError(activityResult)) {
  this.log.warn("Activity post failed", { error: activityResult.error });
  // Continue processing - activity failure doesn't block session
}
```

---

## Key Files

| File                                            | Purpose                                 |
| ----------------------------------------------- | --------------------------------------- |
| `packages/core/src/handlers/ToolHandler.ts`     | Processes tool call events → activities |
| `packages/core/src/handlers/TextHandler.ts`     | Processes text/markdown → activities    |
| `packages/core/src/handlers/TodoHandler.ts`     | Syncs OpenCode todos → Linear plan      |
| `packages/core/src/linear/LinearServiceImpl.ts` | Linear API client wrapper               |
| `packages/core/src/opencode/OpencodeService.ts` | OpenCode SDK wrapper                    |
| `packages/core/src/actions/executor.ts`         | Routes actions to correct service       |
| `packages/server/src/index.ts`                  | HTTP server, webhook routing            |
| `packages/plugin/src/index.ts`                  | OpenCode plugin entry point             |

---

## Troubleshooting

### Common Issues

**`WorktreeNotGitError` when creating sessions:**

1. **Missing `repo:` label** - issue needs a label like `repo:linear-opencode-agent`; default repo path may not be a git repo.
2. **Stale OpenCode server** - check for multiple `opencode serve` processes with `lsof -i :4096`.

**Webhooks not triggering:**

- Re-delegating to same agent does not emit a new webhook
- Check webhook logs in `~/.local/share/linear-opencode-agent/launchd.err`
- Verify tunnel process is running

**Session not resuming:**

- Check if session exists in `~/.local/share/linear-opencode-agent/store.json`
- Verify OpenCode web UI is reachable at `http://localhost:4096`

### Debugging Commands

```bash
# Watch webhook server logs
tail -f ~/.local/share/linear-opencode-agent/launchd.err

# Check for stale OpenCode processes
lsof -i :4096 -P -n

# View pending questions/permissions
cat ~/.local/share/linear-opencode-agent/store.json | grep -E '"question:|"permission:'

# Test OpenCode API directly
curl -X POST "http://localhost:4096/experimental/worktree?directory=/path/to/repo" \
  -H "Content-Type: application/json" \
  -d '{"name": "test"}'
```

---

## External Documentation

Append `.md` to Linear docs URLs for markdown:

- `https://linear.app/developers/agents.md`
- `https://linear.app/developers/webhooks.md`
- `https://linear.app/developers/agent-signals.md`

Optional local clones for SDK source/type lookup:

- `@linear/sdk` -> local clone path of linear repo
- `@opencode-ai/sdk` -> local clone path of opencode repo
