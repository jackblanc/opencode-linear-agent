# Migration Plan: Plugin to SSE Approach

> **Note:** Historical planning doc. Migration completed; keep only for project history.

## Goal

Migrate from the current plugin-based architecture to a pure SSE/SDK approach, simplifying the codebase and aligning with OpenCode's `packages/slack` pattern. This positions the Linear agent for eventual inclusion in the OpenCode monorepo as `packages/linear`.

---

## Current Architecture

```
Cloudflare Worker                         Sandbox Container
┌─────────────────────┐                   ┌─────────────────────────────┐
│                     │                   │ OpenCode Server             │
│  SDK Client         │◄──── SSE ────────│                             │
│  - session.create() │                   │ Plugin: linear-agent.js    │
│  - session.prompt() │                   │ - tool.execute.before/after│
│  - event.subscribe()│                   │ - experimental.text.complete│
│                     │                   │ - event (idle, error, todo) │
└─────────────────────┘                   │                             │
                                          │ Posts directly to Linear ──┼──► Linear API
                                          └─────────────────────────────┘
```

**Problems:**

- Plugin baked into Docker image (deployment complexity)
- Relies on `experimental.*` hooks (API instability)
- Two communication paths (SDK + plugin posting to Linear)
- Harder to integrate into OpenCode monorepo

---

## Target Architecture

```
Cloudflare Worker
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  SDK Client                                              │
│  - session.create()                                      │
│  - session.prompt()                                      │
│  - event.subscribe() ◄─── SSE stream                     │
│  - permission.reply()                                    │
│                                                          │
│  SSEEventHandler                                         │
│  - message.part.updated → Post tool activities to Linear │
│  - permission.asked → Auto-approve all                   │
│  - todo.updated → Sync to Linear agent plan              │
│  - session.idle → Signal completion                      │
│                                                          │
└──────────────────────────────────────────────────────────┘
         │
         ▼
    Linear API
```

**Benefits:**

- Single communication path (all via SDK/SSE)
- No custom Docker image needed (use stock OpenCode)
- Stable public API (no experimental hooks)
- Clean separation for OpenCode integration

---

## Current Package Structure

```
packages/
├── core/                    # Platform-agnostic core logic
│   └── src/
│       ├── EventProcessor.ts      # Webhook handling (MODIFY)
│       ├── session/
│       │   └── SessionManager.ts  # Session lifecycle (MODIFY)
│       └── linear/
│           ├── LinearAdapter.ts   # Linear API interface
│           └── types.ts           # ActivityContent, PlanItem, etc.
├── plugin/                  # OpenCode plugin (DELETE)
├── linear/                  # Cloudflare Worker entry point
├── infrastructure/          # Cloudflare-specific implementations
├── agent/                   # Agent configuration
└── local/                   # Local development adapters
```

---

## Migration Steps

### Phase 1: SSE Event Handler (Complexity: Medium)

Extend the existing `EventProcessor.subscribeAndWaitForIdle()` to handle all events that the plugin currently handles.

| Plugin Hook                  | SSE Event                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `tool.execute.before`        | `message.part.updated` where `part.type === "tool"` and `state.status === "running"`   |
| `tool.execute.after`         | `message.part.updated` where `part.type === "tool"` and `state.status === "completed"` |
| `experimental.text.complete` | `message.part.updated` where `part.type === "text"` and text is complete               |
| `event` → `session.idle`     | `session.idle` event                                                                   |
| `event` → `session.error`    | `session.error` event                                                                  |
| `event` → `todo.updated`     | `todo.updated` event                                                                   |

**Tasks:**

1. Create `SSEEventHandler` class in `packages/core/src/`
   - Accept `LinearAdapter` and target session IDs
   - Process `message.part.updated` events for tool activities
   - Process `message.part.updated` events for text responses
   - Process `todo.updated` events for plan sync
   - Process `permission.asked` events with auto-approve
   - Process `session.idle` and `session.error` for completion

2. Move tool mapping logic from plugin to `SSEEventHandler`:
   - `TOOL_ACTION_MAP` for friendly action names
   - `extractToolParameter()` for parameter extraction
   - `mapTodoStatus()` for todo status mapping
   - Output truncation (500 char limit with "...truncated")

3. Update `EventProcessor.subscribeAndWaitForIdle()`:
   - Instantiate `SSEEventHandler` with LinearAdapter
   - Delegate all event processing to handler
   - Keep existing idle/error break logic

### Phase 2: Permission Handling (Complexity: Low)

Auto-approve all permission requests for simplicity.

```typescript
if (event.type === "permission.asked") {
  await sdk.permission.reply({
    requestID: event.properties.id,
    reply: "always",
  });
}
```

This is appropriate for an agentic coding tool working on delegated issues where the user has already granted trust by delegating the work.

### Phase 3: Simplify Session Management (Complexity: Low)

1. Remove session title prefix hack (`linear:{sessionId}`)
   - Plugin used this to correlate activities to Linear sessions
   - With SSE, we have session context in the worker directly
2. Store Linear session mapping in worker state instead
3. Update `SessionManager.getOrCreateSession()` to use a simpler title

### Phase 4: Remove Plugin (Complexity: Low)

Only after Phases 1-3 are tested and working:

1. Delete `packages/plugin/` directory
2. Update `Dockerfile` to remove plugin build/copy steps:
   ```dockerfile
   # Remove these lines:
   COPY packages/plugin /tmp/plugin
   RUN cd /tmp/plugin \
       && bun install \
       && mkdir -p /root/.config/opencode/plugin \
       && bun build src/index.ts --outdir /root/.config/opencode/plugin --outfile linear-agent.js --target bun --format esm \
       && rm -rf /tmp/plugin
   ```
3. Use stock OpenCode image or minimal custom image

### Phase 5: Testing & Validation (Complexity: Medium)

1. Verify tool activity streaming matches current behavior
   - Running state posts ephemeral activity
   - Completed state posts persistent activity with result
2. Verify text streaming works correctly
   - Text parts posted as response activities
   - Duplicates avoided (track sent part IDs)
3. Verify todo sync works
   - Plan updates on `todo.updated` event
4. Verify session idle/error handling
   - Stop signal sent on idle
   - Error reported on session.error
5. Test permission auto-approve flow

---

## Files to Change

### Delete

- `packages/plugin/` (entire directory) - **Phase 4**

### Modify

- `Dockerfile` - Remove plugin build steps - **Phase 4**
- `packages/core/src/EventProcessor.ts` - Integrate SSEEventHandler - **Phase 1**
- `packages/core/src/session/SessionManager.ts` - Remove title prefix hack - **Phase 3**

### Create

- `packages/core/src/SSEEventHandler.ts` - New event handler class - **Phase 1**

---

## Implementation Details

### SSEEventHandler Class Structure

```typescript
// packages/core/src/SSEEventHandler.ts

import type {
  Event as OpencodeEvent,
  ToolPart,
  TextPart,
} from "@opencode-ai/sdk";
import type { LinearAdapter } from "./linear/LinearAdapter";

// Tool name mapping for friendly action names
const TOOL_ACTION_MAP: Record<string, { action: string; pastTense: string }> = {
  read: { action: "Reading", pastTense: "Read" },
  edit: { action: "Editing", pastTense: "Edited" },
  write: { action: "Creating", pastTense: "Created" },
  bash: { action: "Running", pastTense: "Ran" },
  glob: { action: "Searching files", pastTense: "Searched files" },
  grep: { action: "Searching code", pastTense: "Searched code" },
  task: { action: "Delegating task", pastTense: "Delegated task" },
  todowrite: { action: "Updating plan", pastTense: "Updated plan" },
  todoread: { action: "Reading plan", pastTense: "Read plan" },
};

export class SSEEventHandler {
  private sentTextParts = new Set<string>();
  private toolArgsCache = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly linear: LinearAdapter,
    private readonly linearSessionId: string,
    private readonly opencodeSessionId: string,
    private readonly opencodeClient: OpencodeClient,
  ) {}

  async handleEvent(event: OpencodeEvent): Promise<"continue" | "break"> {
    switch (event.type) {
      case "message.part.updated":
        await this.handlePartUpdated(event.properties);
        return "continue";

      case "todo.updated":
        await this.handleTodoUpdated(event.properties);
        return "continue";

      case "permission.asked":
        await this.handlePermissionAsked(event.properties);
        return "continue";

      case "session.idle":
        if (event.properties.sessionID === this.opencodeSessionId) {
          await this.handleSessionIdle();
          return "break";
        }
        return "continue";

      case "session.error":
        if (event.properties.sessionID === this.opencodeSessionId) {
          await this.handleSessionError(event.properties);
          return "break";
        }
        return "continue";

      default:
        return "continue";
    }
  }

  // ... implementation methods
}
```

### EventProcessor Integration

```typescript
// In EventProcessor.subscribeAndWaitForIdle()

const handler = new SSEEventHandler(
  this.linear,
  linearSessionId,
  opencodeSessionId,
  this.opencodeClient,
);

for await (const event of eventStream.stream) {
  logOpencodeEvent(event, linearSessionId, opencodeSessionId);

  const result = await handler.handleEvent(event);
  if (result === "break") {
    break;
  }
}
```

---

## Risks & Mitigations

| Risk                                       | Mitigation                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| SSE event timing differs from plugin hooks | Test thoroughly; running→completed transition should be equivalent |
| Text streaming behavior changes            | Track sent part IDs; compare output with current plugin            |
| Permission auto-approve too permissive     | Acceptable for delegated work; add allowlist later if needed       |
| Worker timeout during long sessions        | Current approach already handles this (webhook per prompt)         |

---

## Future: OpenCode Integration

Once migrated, the path to `packages/linear` in OpenCode:

1. Extract core Linear client logic (API calls, OAuth, webhooks)
2. Create `packages/linear/` following `packages/slack/` structure
3. Move Cloudflare-specific code to example or separate package
4. Add to OpenCode monorepo

Target structure:

```
packages/linear/
├── src/
│   └── index.ts          # ~200-300 lines, similar to slack
├── package.json
└── README.md
```
