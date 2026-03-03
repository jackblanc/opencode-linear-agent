# OpenCode Integration Strategy

> This document captures the strategic direction for opencode-linear-agent based on analysis of OpenCode's architecture and capabilities.

## Executive Summary

The opencode-linear-agent project should continue as a **sidecar service** that connects to OpenCode via its public SDK/API. This approach:

1. Requires no changes to OpenCode core
2. Can be developed and released independently
3. Uses stable, documented APIs (HTTP + SSE)
4. Can evolve into a plugin if OpenCode adds route mounting support

## OpenCode Architecture Context

### What OpenCode Already Provides

| Capability          | API                                 | Notes                                       |
| ------------------- | ----------------------------------- | ------------------------------------------- |
| Session management  | `POST /session`, `GET /session/:id` | Create, resume, list sessions               |
| Prompts             | `POST /session/:id/message`         | Send messages, stream responses             |
| Event stream        | `GET /event` (SSE)                  | All events: permissions, tools, todos, etc. |
| Permission replies  | `POST /permission/:id/reply`        | Respond to permission requests              |
| Multi-project       | `x-opencode-directory` header       | Route requests to specific project          |
| Worktree management | `POST /worktree`                    | Native git worktree support                 |

### OpenCode Plugin System

Plugins can:

- Receive ALL events via `event` hook
- Access the full SDK client
- Register custom tools
- Intercept permissions via `permission.ask` hook
- Run arbitrary code (including `Bun.serve()`)

Plugins cannot (currently):

- Mount routes on the OpenCode server
- Store session-level metadata
- Intercept HTTP requests

### Implication

The plugin system is powerful but lacks route mounting. Since Linear webhooks need an HTTP endpoint, we must either:

- A) Run a separate HTTP server (current approach)
- B) Wait for OpenCode to add plugin route support

**Decision**: Continue with (A), design code to migrate to (B) when available.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Linear Integration Service                            │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐   │
│  │ Webhook Server   │  │ Event Handler    │  │ Session Manager      │   │
│  │                  │  │ (SSE subscriber) │  │                      │   │
│  │ /webhook/linear  │  │                  │  │ Linear↔OpenCode      │   │
│  │ /oauth/*         │  │ permission.asked │  │ session mapping      │   │
│  │                  │  │ message.part.*   │  │                      │   │
│  │                  │  │ todo.updated     │  │ Project resolution   │   │
│  │                  │  │ session.*        │  │                      │   │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘   │
│           │                     │                       │               │
│           └─────────────────────┴───────────────────────┘               │
│                                 │                                        │
│                      ┌──────────▼──────────┐                            │
│                      │ OpenCode SDK Client │                            │
│                      │ @opencode-ai/sdk/v2 │                            │
│                      └──────────┬──────────┘                            │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │ HTTP + SSE
                                  ▼
                      ┌───────────────────────┐
                      │   OpenCode Server     │
                      │   (no modifications)  │
                      └───────────────────────┘
```

## Deployment Modes

### Mode 1: Connect to Existing OpenCode Server

User runs OpenCode separately, integration connects to it.

```bash
# Terminal 1: User's OpenCode server
opencode serve --port 4096

# Terminal 2: Linear integration
OPENCODE_URL=http://localhost:4096 bun run start
```

### Mode 2: Spawn OpenCode Server

Integration manages OpenCode lifecycle (like the existing Slack package).

```typescript
import { createOpencode } from "@opencode-ai/sdk/v2";

const { client, server } = await createOpencode({ port: 0 });
// Integration uses `client`, `server` handles lifecycle
```

### Mode 3: Future Plugin

If OpenCode adds route mounting to plugins:

```typescript
// .opencode/plugin/linear.ts
export default async function (input: PluginInput): Promise<Hooks> {
  return {
    routes: createLinearRoutes(), // Mounted at /plugin/linear/*
    event: handleEvents,
    "permission.ask": handlePermissions,
  };
}
```

## Project Resolution Strategy

The integration must determine which OpenCode project/directory to use for each Linear issue. This should be flexible, not brittle.

### Resolution Order

1. **Label-based**: `repo:opencode` → `~/projects/opencode`
2. **Team-based**: Linear team "CODE" → `~/projects/opencode`
3. **Discovery**: Scan directories, match by git remote URL
4. **Default**: Fallback directory

### Configuration Schema

```typescript
interface ProjectMapping {
  // Label → directory mapping
  labels?: Record<string, string>;

  // Team key → directory mapping
  teams?: Record<string, string>;

  // Directories to scan for git repos
  discover?: string[];

  // Fallback if nothing matches
  default?: string;
}
```

### Example Configuration

```json
{
  "projects": {
    "labels": {
      "repo:opencode": "~/projects/opencode",
      "repo:reservations": "~/projects/reservations"
    },
    "teams": {
      "CODE": "~/projects/opencode",
      "RES": "~/projects/reservations"
    },
    "discover": ["~/projects"],
    "default": "~/projects/default"
  }
}
```

## Permission Handling

### Current: Auto-Approve

The current implementation auto-approves all permissions since the user granted trust by delegating the issue.

### Future: Interactive via Linear Elicitations

Linear supports `elicitation` activities with `select` signal for interactive approvals.

**Flow:**

1. OpenCode emits `permission.asked` event
2. Integration posts elicitation to Linear with options
3. User clicks option in Linear UI
4. Linear sends `prompted` webhook with selection
5. Integration calls `client.permission.reply()`

**Implementation:**

```typescript
// On permission.asked event
await linear.createAgentActivity({
  agentSessionId: linearSessionId,
  content: {
    type: "elicitation",
    body: `Allow: \`${permission}\`?\n\n${formatMetadata(metadata)}`,
    signalMetadata: { options: ["Allow once", "Always allow", "Reject"] },
  },
  signal: AgentActivitySignal.Select,
});

// Track pending permission
pendingPermissions.set(permissionId, linearSessionId);

// On prompted webhook with selection
const reply = mapSelectionToReply(selection); // "once" | "always" | "reject"
await opencode.permission.reply({
  path: { requestID: permissionId },
  body: { reply },
});
```

### Configuration Option

```json
{
  "permissions": "interactive" | "auto-approve"
}
```

## Session Resumability

Linear sessions can receive follow-up prompts. The integration must:

1. **Map Linear sessions to OpenCode sessions**
2. **Resume existing OpenCode sessions** for follow-ups
3. **Recover context** if OpenCode session is lost

### Session State

```typescript
interface SessionState {
  linearSessionId: string;
  opencodeSessionId: string;
  directory: string;
  branchName: string;
  workdir: string; // Worktree path
  issueId: string;
  lastActivityAt: number;
}
```

### Context Recovery

If OpenCode session is lost (server restart, etc.):

1. Fetch previous messages via `client.session.messages()`
2. Format as context prefix
3. Inject into new session's first prompt

This is already implemented in `SessionManager.formatMessageHistory()`.

## Error Handling

### Error Reporting to Linear

Post full errors including stack traces:

```typescript
const errorBody = stack
  ? `**Error:** ${message}\n\n**Stack:**\n\`\`\`\n${stack}\n\`\`\``
  : `**Error:** ${message}`;

await linear.createAgentActivity({
  agentSessionId,
  content: { type: "error", body: errorBody },
});
```

### Error Categories

| Error Type                  | Handling                                    |
| --------------------------- | ------------------------------------------- |
| Webhook verification failed | Return 401, don't post to Linear            |
| Project resolution failed   | Post error to Linear with available options |
| OpenCode API error          | Post error to Linear, include details       |
| Session creation failed     | Post error to Linear                        |
| Permission denied           | Post to Linear, stop session                |

## External Links

When running as a server, set external link to the OpenCode web UI:

```typescript
const externalLink = `${opcodeBaseUrl}/${encodedWorkdir}/session/${sessionId}`;
await linear.setExternalLink(linearSessionId, externalLink);
```

The `opcodeBaseUrl` should be configurable (for tunnels, public URLs, etc.).

## What We Keep from Current Implementation

| Component                 | Status | Notes                            |
| ------------------------- | ------ | -------------------------------- |
| `packages/core/`          | Keep   | Platform-agnostic business logic |
| `EventProcessor`          | Keep   | Core orchestration               |
| `SSEEventHandler`         | Keep   | Event→Activity mapping           |
| `SessionManager`          | Keep   | Session lifecycle                |
| `LinearServiceImpl`       | Keep   | SDK wrapper with Result types    |
| OAuth handlers            | Keep   | Full OAuth flow                  |
| Webhook verification      | Keep   | HMAC via Linear SDK              |
| `RepoResolver`            | Expand | Add team-based resolution        |
| Worktree via OpenCode API | Keep   | Native, no custom git            |

## What Changes

| Current                     | New                               |
| --------------------------- | --------------------------------- |
| Docker Compose setup        | Simpler single-process            |
| Separate webhook-server     | Integrated into main process      |
| Container orchestration     | Direct OpenCode SDK connection    |
| Cloudflare Workers priority | Self-hosted first, cloud later    |
| Auto-approve only           | Add interactive permission option |

## Implementation Phases

### Phase 1: Simplify Architecture (Low complexity)

- Remove Docker/container complexity
- Single entry point that connects to OpenCode
- Keep all existing core logic

### Phase 2: Enhanced Project Resolution (Low complexity)

- Add team-based project mapping
- Add directory discovery
- More flexible configuration

### Phase 3: Interactive Permissions (Medium complexity)

- Implement elicitation flow
- Track pending permissions
- Parse selection responses

### Phase 4: Improved Developer Experience (Low complexity)

- Better configuration validation
- Clearer error messages
- Setup wizard / CLI

### Phase 5: Cloud Deployment Option (Medium complexity)

- Cloudflare Workers support (re-add if needed)
- Multi-tenant considerations
- Hosted service infrastructure

## Open Questions

1. **State persistence**: File-based JSON (current) vs SQLite vs other?
   - File-based is simple and works
   - SQLite would be more robust for concurrent access
2. **OAuth vs API Key**: Support both or require OAuth?
   - OAuth is more secure, enables app identity
   - API key is simpler for testing
   - Recommendation: Support both, prefer OAuth

3. **Public URL configuration**: How to specify the external-facing URL?
   - Environment variable `PUBLIC_URL`
   - Config file option
   - Auto-detect from tunnel (complex)

## Relationship to OpenCode Project

### Collaboration Points

1. **SDK improvements**: Report issues, contribute fixes
2. **Plugin system**: Advocate for route mounting capability
3. **Documentation**: Contribute integration guides
4. **Testing**: Help test SDK/API changes

### Dependencies

- `@opencode-ai/sdk/v2` - Primary interface
- No internal/private APIs
- SSE event stream as stable contract

### Future Integration Path

If this project proves valuable and the patterns stabilize:

1. Propose integration framework to OpenCode
2. Potentially merge as first-party package
3. Keep backward compatibility with standalone mode

## References

- OpenCode repo: `~/projects/opencode`
- OpenCode SDK: `packages/sdk/js/src/v2/`
- OpenCode plugin interface: `packages/plugin/src/index.ts`
- OpenCode Slack example: `packages/slack/`
- Linear developer docs: https://developers.linear.app/developers/agents
