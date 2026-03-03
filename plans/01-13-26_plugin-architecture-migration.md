# Plugin Architecture Migration

> Migrate from SSE-based event streaming to OpenCode plugin-based architecture for Linear integration.

## Project Summary

**What:** Refactor opencode-linear-agent to use OpenCode's plugin system instead of SSE streaming for posting activities to Linear.

**Why:**

1. **Serverless-ready** - CF Worker becomes stateless fire-and-forget; no long-lived SSE connections
2. **Simpler architecture** - Plugin handles event→Linear posting; Worker just forwards webhooks
3. **Server-agnostic** - Worker can talk to any OpenCode server (local, CF Sandbox, self-hosted)
4. **Open-source friendly** - Users bring their own OpenCode server URL; no complex deployment
5. **Consistent behavior** - Same plugin works regardless of where OpenCode runs

## Current Architecture (SSE-based)

```
Linear → CF Worker → OpenCode SDK (prompt)
                          │
              Worker subscribes to SSE
                          │
              Worker posts to Linear ◄── Events from OpenCode
```

**Problems:**

- Worker must maintain SSE connection (doesn't work well with CF Workers 30s limit)
- Complex state management for in-flight events
- Tight coupling between Worker and OpenCode event stream
- Can't easily support ephemeral compute (CF Sandbox)

## Target Architecture (Plugin-based)

```
Linear ──webhook──► CF Worker ──SDK──► OpenCode Server (anywhere)
                        │                      │
                        │                 Plugin listens to events
                        │                      │
                        │                 Plugin posts directly to Linear
                        │                      │
                   fire-and-forget             ▼
                   (returns 200)           LINEAR API
```

**Benefits:**

- Worker is stateless - receives webhook, calls OpenCode SDK, returns immediately
- Plugin runs inside OpenCode - natural access to all events
- No SSE connection management
- Works with any OpenCode server (local, sandbox, cloud)
- Multi-tenant ready - each user configures their own OpenCode URL

## Components

### 1. CF Worker (Webhook Handler)

**Responsibilities:**

- Validate Linear webhook signatures
- Look up user's OpenCode server URL (from KV/config)
- Look up user's OpenCode config (from KV)
- Resolve repository from issue labels (current `RepoResolver` logic)
- Use OpenCode SDK to:
  - Create/reuse worktree
  - Create/resume session
  - Send prompt with Linear context embedded
- Store session mapping in KV/Durable Objects
- Return 200 immediately (fire-and-forget)

**Does NOT:**

- Subscribe to SSE
- Post activities to Linear
- Wait for OpenCode completion

### 2. OpenCode Plugin (`linear-activity`)

**Responsibilities:**

- Parse Linear context from first message (Linear session ID, issue identifier)
- Authenticate to Linear via OAuth (separate app/actor from MCP - see Plugin OAuth below)
- Listen to OpenCode events via `event` hook
- Post activities to Linear API:
  - Tool executions → action activities
  - Text responses → response activities
  - Todos → plan updates
  - Errors → error activities
  - Session idle → completion response
- Handle permissions (auto-approve or post elicitation)
- Handle questions (post elicitation)

**Plugin location:** `.opencode/plugin/linear-activity.ts` (or published npm package)

### 3. State Storage (CF KV / Durable Objects)

**Stored in KV:**

- User configurations (OpenCode URL, Linear org ID, webhook secret)

**Stored in Durable Objects:**

- Linear session → OpenCode session mapping
- Worktree info per issue
- Pending questions/permissions

## Data Flow

### Session Creation

```
1. User delegates issue in Linear
2. Linear sends AgentSessionEvent webhook to CF Worker
3. Worker validates signature, looks up user config
4. Worker resolves repo from issue labels
5. Worker calls OpenCode SDK:
   - POST /worktree (create/reuse)
   - POST /session (create)
   - POST /session/:id/message (prompt with Linear context)
6. Worker stores session mapping in DO
7. Worker returns 200 to Linear
8. OpenCode processes prompt, plugin posts activities to Linear
```

### Follow-up Prompt

```
1. User sends message in Linear agent UI
2. Linear sends prompted webhook to CF Worker
3. Worker looks up OpenCode session from DO
4. Worker calls OpenCode SDK:
   - POST /session/:id/message (follow-up prompt)
5. Worker returns 200
6. Plugin posts activities to Linear
```

### Question/Permission Handling

```
1. OpenCode asks question or permission
2. Plugin posts elicitation to Linear (includes unique elicitationId)
3. Worker stores pending state in DO: elicitationId → { opencodeSessionId, type }
4. User responds in Linear
5. Linear sends prompted webhook with elicitation response
6. Worker looks up pending elicitation from DO
7. Worker calls OpenCode SDK to reply to permission/question
8. OpenCode continues, plugin posts activities
```

Note: Plugin is stateless - it posts elicitations but doesn't track responses. Worker owns all pending state.

## Linear Context Protocol

The Worker embeds Linear context in the first message for the plugin to parse:

```
---LINEAR-CONTEXT---
sessionId: abc-123-def
issueIdentifier: CODE-42
---END-LINEAR-CONTEXT---

{actual prompt content}
```

- `sessionId` - Linear agent session ID (for posting activities)
- `issueIdentifier` - Linear issue identifier (e.g., `CODE-42`)

Plugin parses this on first message and stores for subsequent events. The plugin authenticates to Linear separately via OAuth (not embedded in the message).

**Alternative:** Use OpenCode session metadata if SDK supports it (cleaner, but may not exist).

## Implementation Plan

### Phase 1: Create Plugin (Medium complexity)

**Deliverables:**

- [ ] `packages/opencode-plugin/` - New package for the Linear activity plugin
- [ ] Event handler that posts to Linear API
- [ ] Linear context parser (from first message)
- [ ] Activity posting for: tools, text, todos, errors, completion
- [ ] Permission/question elicitation posting

**Port from current codebase:**

- `OpencodeEventProcessor` logic → plugin event handler
- `processToolPart`, `processTextPart`, etc. → plugin handlers
- `LinearServiceImpl` → plugin's Linear client

**Depends on:** OpenCode plugin OAuth support (see Open Questions)

### Phase 2: CF Worker (Medium complexity)

**Deliverables:**

- [ ] `packages/worker/` - New CF Worker package
- [ ] Webhook validation (port from `core/webhook/handlers.ts`)
- [ ] OpenCode SDK integration for session/worktree management
- [ ] Linear context injection into prompts
- [ ] KV bindings for user config
- [ ] Durable Object for session state
- [ ] Repo resolution (port from `server/RepoResolver.ts`)

**Port from current codebase:**

- `handleWebhook` → Worker fetch handler
- `LinearEventProcessor.process()` → Worker logic (minus SSE)
- `WorktreeManager`, `SessionManager` → Worker (SDK calls only)
- `PromptBuilder` → Worker

### Phase 3: State Migration (Low complexity)

**Deliverables:**

- [ ] Durable Object schema for session mapping
- [ ] KV schema for user configs
- [ ] Migration path from file-based storage

### Phase 4: Local Development Support (Low complexity)

**Deliverables:**

- [ ] `wrangler dev` setup for local testing
- [ ] Tunnel integration for local OpenCode
- [ ] Documentation for local setup

### Phase 5: Cleanup (Low complexity)

**Deliverables:**

- [ ] Remove SSE subscription code from core
- [ ] Remove `packages/server/` (replaced by Worker)
- [ ] Update README and docs
- [ ] Remove Docker Compose setup (optional - may keep for local dev)

## Package Structure (Target)

```
opencode-linear-agent/
├── packages/
│   ├── core/                    # Shared types, utilities, error handling
│   │   └── src/
│   │       ├── errors/          # Tagged error types
│   │       ├── linear/          # Linear types (ActivityContent, etc.)
│   │       └── utils/           # Shared utilities
│   │
│   ├── opencode-plugin/         # OpenCode plugin (NEW)
│   │   └── src/
│   │       ├── index.ts         # Plugin entry point
│   │       ├── context.ts       # Linear context parser
│   │       ├── handlers/        # Event handlers (tool, text, todo, etc.)
│   │       └── linear.ts        # Linear API client
│   │
│   └── worker/                  # CF Worker (NEW)
│       └── src/
│           ├── index.ts         # Worker entry point
│           ├── webhook.ts       # Webhook validation
│           ├── session.ts       # Session/worktree management
│           ├── prompt.ts        # Prompt building with context
│           ├── storage/         # KV + DO bindings
│           └── wrangler.toml    # Worker config
│
├── .opencode/
│   └── plugin/
│       └── linear-activity.ts   # Symlink to packages/opencode-plugin for local dev
│
└── plans/
```

## Configuration

### User Configuration (stored in KV)

```json
{
  "opencode": {
    "url": "https://opencode.example.com",
    "apiKey": "optional-if-needed"
  },
  "linear": {
    "organizationId": "org-uuid",
    "webhookSecret": "lin_wh_..."
  },
  "projects": {
    "labels": {
      "repo:myapp": "/path/to/myapp"
    },
    "default": "/path/to/default"
  }
}
```

Note: Linear OAuth tokens are stored in OpenCode's plugin config, not in KV. The plugin authenticates to Linear independently using OAuth (similar to how Linear MCP authenticates).

### Worker Environment (wrangler.toml)

```toml
[vars]
LINEAR_WEBHOOK_SECRET = "lin_wh_..."

[[kv_namespaces]]
binding = "CONFIG"
id = "..."

[[durable_objects.bindings]]
name = "SESSIONS"
class_name = "SessionStore"
```

## Open Questions

1. **Plugin OAuth support in OpenCode:**
   - Plugin needs its own OAuth flow to Linear (separate app/actor from Linear MCP)
   - OpenCode server must support plugin-specific OAuth configuration
   - Similar pattern to `opencode mcp auth linear`, but for plugins
   - **Blocker:** Need to implement this in OpenCode before plugin can authenticate

2. **Plugin distribution:**
   - Ship as npm package (`@opencode-linear-agent/plugin`)?
   - Or users copy into `.opencode/plugin/`?
   - Or both (npm for prod, local for dev)?

3. **Multi-tenant auth:**
   - Each user stores their own Linear OAuth in KV
   - Worker looks up by org ID from webhook
   - How do users initially authenticate? (separate OAuth flow via Worker?)

4. **OpenCode server discovery:**
   - User provides URL in config
   - How to handle auth to OpenCode server? (if protected by tunnel/access)

5. **Question/permission state:**
   - Plugin posts elicitation to Linear with unique `elicitationId`
   - Worker stores pending state in DO: `elicitationId → { opencodeSessionId, type }`
   - User responds in Linear → webhook to Worker
   - Worker looks up pending elicitation, calls OpenCode SDK to reply
   - Plugin is stateless - just fires elicitations, doesn't track responses

6. **Cold start for CF Sandbox:**
   - Out of scope for this plan
   - Assume OpenCode server exists somewhere
   - Sandbox integration is future work

## Success Criteria

1. **Worker receives webhook, OpenCode posts activity to Linear** - End-to-end flow works
2. **No SSE connections** - Worker is stateless fire-and-forget
3. **Local OpenCode works** - Can test with local server via tunnel
4. **Session resumption works** - Follow-up prompts go to same OpenCode session
5. **Questions/permissions work** - Elicitations flow through correctly

## Migration Path

1. Build plugin + worker in parallel with existing system
2. Test with local OpenCode first
3. Deploy Worker to CF, point Linear webhook to it
4. Deprecate Docker Compose setup
5. Remove SSE code paths from core

## References

- OpenCode plugin docs: https://opencode.ai/docs/plugins
- OpenCode SDK: `~/projects/opencode/packages/sdk/`
- CF Workers docs: https://developers.cloudflare.com/workers/
- CF Durable Objects: https://developers.cloudflare.com/durable-objects/
- Linear Agent docs: https://linear.app/developers/agents.md
