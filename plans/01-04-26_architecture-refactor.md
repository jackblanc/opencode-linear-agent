# Architecture Refactor: Queue-Based Decoupling & Package Restructure

**Date**: January 4, 2026  
**Status**: Approved for Implementation (Revised)

## Overview

This plan addresses the brittleness of the current codebase by:

1. Introducing queue-based decoupling to solve the Cloudflare timeout issue
2. Splitting into three workers: Linear (webhooks/OAuth), Agent (queue consumer), UI Proxy
3. Restructuring into multiple packages with clear domain boundaries
4. Abstracting ALL Cloudflare resources (KV, Queue, Sandbox) behind interfaces
5. Enabling local development with swappable implementations
6. Simplifying the OpenCode plugin to focus only on activity streaming

## Current Problems

| Problem                              | Impact                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| Monolithic `webhook.ts` (688 lines)  | Hard to test, reason about, modify                                 |
| No domain boundaries                 | Infrastructure mixed with business logic                           |
| Implicit state management            | State scattered across KV, sandbox, filesystem                     |
| Tight coupling to Cloudflare/Sandbox | No unit testing, painful local dev                                 |
| Ad-hoc error handling                | Partial state left behind on failures                              |
| Plugin does too much                 | Git checking, continuation prompts belong in orchestrator          |
| `waitUntil` timeout                  | Cloudflare kills long I/O operations                               |
| Silent failures                      | Errors not reported to Linear, sessions show "Ongoing" for 30+ min |

## Target Architecture

```
linear-opencode-agent/
├── packages/
│   ├── linear/                    # Linear Worker: webhooks + OAuth
│   │   ├── src/
│   │   │   ├── index.ts           # Route dispatch
│   │   │   └── routes/
│   │   │       ├── webhook.ts     # Verify signature -> enqueue -> 200 OK
│   │   │       ├── oauth.ts       # OAuth flow
│   │   │       └── health.ts      # Health check
│   │   └── wrangler.jsonc
│   │
│   ├── agent/                     # Agent Worker: queue consumer
│   │   ├── src/
│   │   │   └── index.ts           # Queue handler, wires up dependencies
│   │   └── wrangler.jsonc
│   │
│   ├── ui-proxy/                  # UI Proxy Worker: forwards to OpenCode UI
│   │   ├── src/
│   │   │   └── index.ts           # Admin auth + proxy to sandbox
│   │   └── wrangler.jsonc
│   │
│   ├── core/                      # Domain logic (platform-agnostic)
│   │   └── src/
│   │       ├── index.ts           # Public exports
│   │       ├── EventProcessor.ts  # Main entry: processes LinearEvent
│   │       ├── session/
│   │       │   ├── SessionManager.ts
│   │       │   ├── SessionState.ts
│   │       │   └── SessionRepository.ts  # Interface
│   │       ├── git/
│   │       │   ├── GitOperations.ts      # Interface
│   │       │   └── types.ts
│   │       ├── linear/
│   │       │   ├── LinearAdapter.ts      # Interface
│   │       │   └── types.ts
│   │       └── types.ts
│   │
│   ├── infrastructure/            # ALL Cloudflare resource abstractions
│   │   └── src/
│   │       ├── index.ts
│   │       ├── cloudflare/        # Cloudflare implementations
│   │       │   ├── KVSessionRepository.ts
│   │       │   ├── KVTokenStore.ts
│   │       │   ├── CloudflareQueue.ts
│   │       │   ├── CloudflareSandbox.ts  # Only place that imports @cloudflare/sandbox
│   │       │   └── index.ts
│   │       ├── local/             # Local implementations (future)
│   │       │   ├── InMemorySessionRepository.ts
│   │       │   ├── InMemoryTokenStore.ts
│   │       │   ├── LocalQueue.ts
│   │       │   ├── LocalSandbox.ts
│   │       │   └── index.ts
│   │       ├── LinearClientAdapter.ts
│   │       └── types.ts           # Shared infrastructure interfaces
│   │
│   └── plugin/                    # Simplified: activity streaming only
│       └── src/
│           └── index.ts
│
├── package.json
└── tsconfig.json
```

## Key Design Principles

### 1. Core Knows Nothing About Infrastructure

The `core` package receives:

- An `OpencodeClient` (from `@opencode-ai/sdk`) - doesn't know where it comes from
- A `LinearAdapter` interface - for reporting activities
- A `SessionRepository` interface - for persisting state
- A `GitOperations` interface - for git commands

```typescript
// Core's main entry point - no infrastructure knowledge
export class EventProcessor {
  constructor(
    private opencodeClient: OpencodeClient,
    private linear: LinearAdapter,
    private sessions: SessionRepository,
    private git: GitOperations,
  ) {}

  async process(
    event: AgentSessionEventWebhookPayload,
    workerUrl: string,
  ): Promise<void> {
    try {
      // ... process event using injected dependencies
    } catch (error) {
      await this.linear.postError(event.agentSession.id, error);
      throw error;
    }
  }
}
```

### 2. Infrastructure Abstracts ALL Cloudflare Resources

The `infrastructure` package is the **only** place that imports Cloudflare-specific modules:

```typescript
// Infrastructure interfaces (in infrastructure/src/types.ts)

interface SandboxProvider {
  // Get the sandbox for an organization (creates if needed)
  // Returns an OpencodeClient ready to use
  getOpencodeClient(
    organizationId: string,
    workdir: string,
  ): Promise<OpencodeClient>;

  // Proxy HTTP request to the sandbox's OpenCode UI
  proxyToOpencode(organizationId: string, request: Request): Promise<Response>;

  // Execute a command in the sandbox
  exec(
    organizationId: string,
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult>;
}

interface Queue<T> {
  send(message: T): Promise<void>;
}

interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### 3. One Sandbox Per Organization

- Each organization gets a single persistent Sandbox
- The Sandbox can clone any repo on demand
- All sessions for that org share the same Sandbox
- Agent worker and UI Proxy worker access the same Sandbox instance

### 4. Swappable Implementations

```typescript
// Cloudflare production
import {
  CloudflareSandbox,
  CloudflareKV,
  CloudflareQueue,
} from "@linear-opencode-agent/infrastructure/cloudflare";

// Local development / testing
import {
  LocalSandbox,
  InMemoryKV,
  LocalQueue,
} from "@linear-opencode-agent/infrastructure/local";
```

## Package Responsibilities

### `@linear-opencode-agent/linear`

- **Role**: Cloudflare Worker for Linear integration
- **Responsibilities**:
  - Verify Linear webhook signatures
  - Enqueue events to the queue
  - Handle OAuth flow
- **Dependencies**: `infrastructure` (for queue, KV)

### `@linear-opencode-agent/agent`

- **Role**: Cloudflare Worker for processing queued events
- **Responsibilities**:
  - Consume events from queue
  - Get `OpencodeClient` from `SandboxProvider`
  - Wire up dependencies and call into core
  - Report all errors to Linear
- **Dependencies**: `core`, `infrastructure`

### `@linear-opencode-agent/ui-proxy`

- **Role**: Cloudflare Worker for OpenCode UI access
- **Responsibilities**:
  - Validate admin API key
  - Proxy requests to Sandbox's OpenCode UI via `SandboxProvider`
- **Dependencies**: `infrastructure`

### `@linear-opencode-agent/core`

- **Role**: Platform-agnostic domain logic
- **Responsibilities**:
  - Process Linear events
  - Session lifecycle management
  - Orchestrate OpenCode prompts
  - Business rules
- **Dependencies**: `@opencode-ai/sdk` (types only), `@linear/sdk` (types only)
- **No imports from**: `@cloudflare/*`, infrastructure implementations

### `@linear-opencode-agent/infrastructure`

- **Role**: All platform-specific implementations
- **Responsibilities**:
  - Cloudflare: KV, Queue, Sandbox abstractions
  - Local: In-memory/file-based alternatives
  - Linear API adapter
- **The ONLY package that imports**: `@cloudflare/sandbox`, `@cloudflare/workers-types`

### `@linear-opencode-agent/plugin`

- **Role**: Activity streaming inside OpenCode process
- **Responsibilities**:
  - Stream tool activities to Linear
  - Stream text responses to Linear
  - Report errors
  - Send Stop signal on session.idle
- **NOT responsible for**:
  - Git status checking
  - Continuation prompts

## Queue-Based Flow

### New Session (`created`)

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Linear sends webhook                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Linear Worker                                                │
│    - Verify Linear signature                                    │
│    - Parse payload                                              │
│    - queue.send({ payload, workerUrl })                         │
│    - Return 200 OK immediately                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Queue (linear-agent-events)                                  │
│    - 15 minute execution limit                                  │
│    - Automatic retries on failure (max 3)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Agent Worker                                                 │
│    a. sandboxProvider.getOpencodeClient(orgId, workdir)         │
│    b. Create LinearAdapter, SessionRepository, GitOperations    │
│    c. new EventProcessor(client, linear, sessions, git)         │
│    d. eventProcessor.process(payload)                           │
│                                                                 │
│    ALL errors caught and reported to Linear                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. EventProcessor (core)                                        │
│    - Post acknowledgment to Linear                              │
│    - Get/create session state                                   │
│    - Ensure worktree exists (via GitOperations)                 │
│    - Create OpenCode session if needed                          │
│    - Send prompt via OpencodeClient                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. Plugin (in sandbox)                                          │
│    - Streams activities to Linear                               │
│    - On session.idle: sends Stop signal                         │
└─────────────────────────────────────────────────────────────────┘
```

### UI Proxy Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User requests /opencode?session=xyz                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. UI Proxy Worker                                              │
│    - Validate admin API key                                     │
│    - sandboxProvider.proxyToOpencode(orgId, request)            │
│    - Return proxied response                                    │
└─────────────────────────────────────────────────────────────────┘
```

## Core Interfaces

### SessionRepository

```typescript
interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  issueId: string;
  branchName: string;
  workdir: string;
  lastActivityTime: number;
}

interface SessionRepository {
  get(linearSessionId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  delete(linearSessionId: string): Promise<void>;
}
```

### GitOperations

```typescript
interface GitStatus {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  branchName: string;
}

interface WorktreeInfo {
  workdir: string;
  branchName: string;
}

interface GitOperations {
  ensureRepoCloned(repoUrl: string): Promise<void>;
  ensureWorktree(
    sessionId: string,
    issueId: string,
    existingBranch?: string,
  ): Promise<WorktreeInfo>;
  getStatus(workdir: string): Promise<GitStatus>;
}
```

### LinearAdapter

```typescript
interface ActivityContent {
  type: "thought" | "action" | "response" | "error";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

interface LinearAdapter {
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
  ): Promise<void>;
  postError(sessionId: string, error: unknown): Promise<void>;
  setExternalLink(sessionId: string, url: string): Promise<void>;
}
```

## Infrastructure Interfaces

```typescript
// SandboxProvider - abstracts Cloudflare Sandbox completely
interface SandboxProvider {
  getOpencodeClient(
    organizationId: string,
    workdir: string,
  ): Promise<OpencodeClient>;
  proxyToOpencode(organizationId: string, request: Request): Promise<Response>;
  exec(
    organizationId: string,
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult>;
}

interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Queue - abstracts Cloudflare Queue
interface Queue<T> {
  send(message: T): Promise<void>;
}

// KeyValueStore - abstracts Cloudflare KV
interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  put(
    key: string,
    value: unknown,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

// TokenStore - for OAuth tokens
interface TokenStore {
  getAccessToken(organizationId: string): Promise<string | null>;
  setAccessToken(organizationId: string, token: string): Promise<void>;
}
```

## Event Types

```typescript
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";

interface LinearEventMessage {
  payload: AgentSessionEventWebhookPayload;
  workerUrl: string;
}
```

## Implementation Phases

### Phase 1: Package Structure + Interfaces (Complexity: Low)

1. Create new package structure: `linear/`, `agent/`, `ui-proxy/`, `core/`, `infrastructure/`, `plugin/`
2. Define all core interfaces
3. Define all infrastructure interfaces
4. Update root package.json workspaces
5. Verify monorepo builds

### Phase 2: Core Domain Logic (Complexity: Medium)

1. Implement `EventProcessor`
2. Implement `SessionManager`
3. All business logic uses injected interfaces
4. Zero Cloudflare imports in core

### Phase 3: Infrastructure - Cloudflare (Complexity: Medium)

1. Implement `CloudflareSandbox` (only place that imports `@cloudflare/sandbox`)
2. Implement `CloudflareKV`
3. Implement `CloudflareQueue`
4. Implement `KVSessionRepository`
5. Implement `KVTokenStore`
6. Implement `LinearClientAdapter`

### Phase 4: Workers (Complexity: Medium)

1. Create queue: `wrangler queues create linear-agent-events`
2. Implement Linear worker (webhook + OAuth)
3. Implement Agent worker (queue consumer)
4. Implement UI Proxy worker
5. Configure all wrangler.jsonc files
6. Delete old monolithic worker

### Phase 5: Simplify Plugin (Complexity: Low)

1. Remove git checking logic
2. Remove continuation prompts
3. Keep only activity streaming
4. Simplify session.idle to just send Stop

### Phase 6 (Future): Local Infrastructure

1. Implement `LocalSandbox` (Docker-based or direct process)
2. Implement `InMemoryKV`
3. Implement `LocalQueue`
4. Enable full local development without Cloudflare

## Error Handling Strategy

**Critical Rule**: Every error MUST be reported to Linear.

### Agent Worker Error Handling

```typescript
async function handleQueueMessage(
  message: LinearEventMessage,
  env: Env,
): Promise<void> {
  const { payload, workerUrl } = message;
  const linearSessionId = payload.agentSession.id;

  // Create Linear client for error reporting FIRST
  const linearClient = await createLinearClient(env, payload.organizationId);

  try {
    const sandboxProvider = new CloudflareSandbox(env);
    const opencodeClient = await sandboxProvider.getOpencodeClient(
      payload.organizationId,
      workdir,
    );
    // ... create other dependencies, process event
  } catch (error) {
    // ALWAYS report to Linear
    try {
      await linearClient.createAgentActivity({
        agentSessionId: linearSessionId,
        content: {
          type: "error",
          body: `Processing failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    } catch (reportError) {
      console.error("Failed to report error to Linear:", reportError);
    }
    throw error; // Re-throw for queue retry
  }
}
```

## Package Dependencies

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ linear       │   │ agent        │   │ ui-proxy     │
│ worker       │   │ worker       │   │ worker       │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────┐
│                  infrastructure                      │
│  ┌─────────────────┐  ┌─────────────────┐           │
│  │ cloudflare/     │  │ local/ (future) │           │
│  │ - Sandbox       │  │ - LocalSandbox  │           │
│  │ - KV            │  │ - InMemoryKV    │           │
│  │ - Queue         │  │ - LocalQueue    │           │
│  └─────────────────┘  └─────────────────┘           │
└──────────────────────────┬──────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ core         │   │ @cloudflare/ │   │ @linear/sdk  │
│ (interfaces) │   │ sandbox      │   │              │
└──────────────┘   └──────────────┘   └──────────────┘
       │
       │ types only
       ▼
┌──────────────┐
│ @opencode/   │
│ sdk          │
└──────────────┘
```

## Success Criteria

- [ ] Webhook responds in <100ms (just enqueue + ack)
- [ ] Queue events complete within 2 minutes for new sessions
- [ ] Queue events complete within 10 seconds for follow-ups
- [ ] No `IoContext timed out` errors
- [ ] **All errors reported to Linear within seconds**
- [ ] Core package has zero Cloudflare imports
- [ ] Infrastructure package is the ONLY place with `@cloudflare/*` imports
- [ ] All existing functionality preserved

## Risks & Mitigations

| Risk                                     | Mitigation                                        |
| ---------------------------------------- | ------------------------------------------------- |
| Queue adds latency                       | User sees "Starting..." activity immediately      |
| Queue event fails after partial work     | Idempotency checks resume from last good state    |
| Error reporting fails                    | Log error, queue will retry, eventual consistency |
| Plugin simplification breaks something   | Test thoroughly before deploying                  |
| Three workers adds deployment complexity | All deployed via same CI pipeline                 |
| Sandbox sharing across workers           | Same org ID maps to same Sandbox instance         |

## Next Steps

1. Review and approve this revised plan
2. Begin Phase 1: Package structure + interfaces
3. Iterate through phases with testing at each step
