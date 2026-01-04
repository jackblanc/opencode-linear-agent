# Architecture Refactor: Queue-Based Decoupling & Package Restructure

**Date**: January 4, 2026  
**Status**: Approved for Implementation

## Overview

This plan addresses the brittleness of the current codebase by:
1. Introducing queue-based decoupling to solve the Cloudflare timeout issue
2. Restructuring into multiple packages with clear domain boundaries
3. Enabling unit testing through dependency inversion
4. Simplifying the OpenCode plugin to focus only on activity streaming

## Current Problems

| Problem | Impact |
|---------|--------|
| Monolithic `webhook.ts` (676 lines) | Hard to test, reason about, modify |
| No domain boundaries | Infrastructure mixed with business logic |
| Implicit state management | State scattered across KV, sandbox, filesystem |
| Tight coupling to Cloudflare | No unit testing, painful local dev |
| Ad-hoc error handling | Partial state left behind on failures |
| Plugin does too much | Git checking, continuation prompts belong in orchestrator |
| `waitUntil` timeout | Cloudflare kills long I/O operations |

## Target Architecture

```
linear-opencode-agent/
├── packages/
│   ├── worker/                    # Cloudflare Worker (thin entry point)
│   │   └── src/
│   │       ├── index.ts           # Route dispatch + queue export
│   │       ├── routes/
│   │       │   ├── webhook.ts     # Verify signature → enqueue → 200 OK
│   │       │   ├── oauth.ts       # OAuth flow (mostly unchanged)
│   │       │   ├── health.ts      # Health check endpoint
│   │       │   └── opencode.ts    # Proxy to OpenCode UI
│   │       ├── queue.ts           # Queue consumer (heavy lifting)
│   │       └── bindings.ts        # Cloudflare binding types
│   │
│   ├── core/                      # Domain logic (platform-agnostic)
│   │   └── src/
│   │       ├── index.ts           # Public exports
│   │       ├── session/
│   │       │   ├── SessionManager.ts
│   │       │   ├── SessionState.ts
│   │       │   └── ISessionRepository.ts
│   │       ├── git/
│   │       │   ├── GitService.ts
│   │       │   ├── IGitService.ts
│   │       │   └── types.ts
│   │       ├── linear/
│   │       │   ├── LinearClientWrapper.ts
│   │       │   ├── ActivityReporter.ts
│   │       │   ├── ILinearClient.ts
│   │       │   └── webhook-types.ts
│   │       ├── opencode/
│   │       │   ├── OpencodeOrchestrator.ts
│   │       │   ├── IOpencodeService.ts
│   │       │   └── types.ts
│   │       └── jobs/
│   │           ├── JobProcessor.ts
│   │           └── types.ts
│   │
│   ├── infrastructure/            # Cloudflare-specific implementations
│   │   └── src/
│   │       ├── index.ts
│   │       ├── KVSessionRepository.ts
│   │       ├── KVTokenStore.ts
│   │       ├── SandboxGitService.ts
│   │       ├── SandboxOpencodeService.ts
│   │       └── CloudflareLogger.ts
│   │
│   └── opencode-linear-plugin/    # Simplified: activity streaming only
│       └── src/
│           └── index.ts
│
├── package.json
├── tsconfig.json
└── wrangler.jsonc
```

## Package Responsibilities

### `@linear-opencode-agent/worker`
- **Role**: Cloudflare Worker entry point
- **Responsibilities**:
  - Route HTTP requests to handlers
  - Export queue consumer
  - Wire up dependencies (DI container)
- **Dependencies**: `core`, `infrastructure`

### `@linear-opencode-agent/core`
- **Role**: Platform-agnostic domain logic
- **Responsibilities**:
  - Session lifecycle management
  - Job processing orchestration
  - Business rules (when to commit, when to stop)
- **Dependencies**: None (only interfaces)
- **Testability**: 100% unit testable with mocks

### `@linear-opencode-agent/infrastructure`
- **Role**: Cloudflare-specific implementations
- **Responsibilities**:
  - KV operations (sessions, tokens)
  - Sandbox operations (git, opencode)
  - R2 storage (if needed)
- **Dependencies**: `core` (implements interfaces)

### `opencode-linear-plugin`
- **Role**: Activity streaming inside OpenCode process
- **Responsibilities**:
  - Stream tool activities to Linear
  - Stream text responses to Linear
  - Report errors
- **NOT responsible for**:
  - Git status checking (moved to queue consumer)
  - Continuation prompts (moved to queue consumer)
  - Session completion logic

## Queue-Based Flow

### New Session (`created`)

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Linear sends webhook                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Worker (webhook.ts)                                          │
│    - Verify Linear signature                                    │
│    - Parse payload                                              │
│    - Enqueue: { type: "session.created", ... }                  │
│    - Return 200 OK immediately                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Queue (Cloudflare Queue)                                     │
│    - 15 minute execution limit                                  │
│    - Automatic retries on failure                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Queue Consumer (queue.ts)                                    │
│    - Post acknowledgment to Linear                              │
│    - SessionManager.initializeSession()                         │
│      - Clone repo (if needed)                                   │
│      - Create worktree                                          │
│      - Install dependencies                                     │
│      - Create OpenCode session                                  │
│    - OpencodeOrchestrator.sendPrompt()                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. OpenCode Plugin (in sandbox)                                 │
│    - Streams activities to Linear                               │
│    - On session.idle: posts "completed" with Stop signal        │
└─────────────────────────────────────────────────────────────────┘
```

### Follow-up (`prompted`)

```
Webhook → Enqueue → Queue Consumer → OpencodeOrchestrator.sendPrompt()
                                            │
                         (session already initialized, no git work)
```

### Stop Signal

```
Webhook → Enqueue → Queue Consumer → OpencodeOrchestrator.abort()
                                            │
                         → Post "stopped" activity to Linear
```

## Core Interfaces

### ISessionRepository

```typescript
interface ISessionRepository {
  get(linearSessionId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  delete(linearSessionId: string): Promise<void>;
}
```

### IGitService

```typescript
interface IGitService {
  ensureRepoCloned(repoUrl: string, targetDir: string): Promise<void>;
  createWorktree(repoDir: string, worktreeDir: string, branchName: string, fromRemote?: boolean): Promise<void>;
  configureUser(workdir: string, name: string, email: string): Promise<void>;
  setRemoteUrl(workdir: string, url: string): Promise<void>;
  installDependencies(workdir: string): Promise<void>;
  getStatus(workdir: string): Promise<GitStatus>;
  worktreeExists(worktreeDir: string): Promise<boolean>;
}
```

### ILinearClient

```typescript
interface ILinearClient {
  createActivity(sessionId: string, content: ActivityContent, ephemeral?: boolean, signal?: ActivitySignal): Promise<void>;
  updateSessionLink(sessionId: string, externalLink: string): Promise<void>;
  getAccessToken(organizationId: string): Promise<string>;
}
```

### IOpencodeService

```typescript
interface IOpencodeService {
  initialize(workdir: string): Promise<void>;
  createSession(title: string): Promise<string>;
  getSession(sessionId: string): Promise<OpencodeSession | null>;
  sendPrompt(sessionId: string, prompt: string, model?: ModelConfig): Promise<void>;
  abort(sessionId: string): Promise<void>;
}
```

## Job Types

```typescript
type AgentJob =
  | {
      type: "session.created";
      linearSessionId: string;
      organizationId: string;
      issueId: string;
      prompt: string;
      workerUrl: string;
    }
  | {
      type: "session.prompted";
      linearSessionId: string;
      organizationId: string;
      prompt: string;
      signal?: "stop";
    };
```

## Wrangler Queue Configuration

```jsonc
// wrangler.jsonc additions
{
  "queues": {
    "producers": [
      {
        "queue": "linear-agent-jobs",
        "binding": "JOBS_QUEUE"
      }
    ],
    "consumers": [
      {
        "queue": "linear-agent-jobs",
        "max_batch_size": 1,
        "max_retries": 3,
        "dead_letter_queue": "linear-agent-dlq"
      }
    ]
  }
}
```

## Implementation Plan

### Phase 1: Create Package Structure (Complexity: Low)

1. Create `packages/core/` with package.json, tsconfig.json
2. Create `packages/infrastructure/` with package.json, tsconfig.json
3. Update root package.json workspaces
4. Verify monorepo builds

### Phase 2: Define Core Interfaces (Complexity: Low)

1. Create `core/src/session/ISessionRepository.ts`
2. Create `core/src/session/SessionState.ts`
3. Create `core/src/git/IGitService.ts`
4. Create `core/src/git/types.ts`
5. Create `core/src/linear/ILinearClient.ts`
6. Create `core/src/opencode/IOpencodeService.ts`
7. Create `core/src/jobs/types.ts`

### Phase 3: Implement Core Domain Logic (Complexity: Medium)

1. Implement `core/src/session/SessionManager.ts`
2. Implement `core/src/linear/ActivityReporter.ts`
3. Implement `core/src/opencode/OpencodeOrchestrator.ts`
4. Implement `core/src/jobs/JobProcessor.ts`
5. Write unit tests for each

### Phase 4: Implement Infrastructure (Complexity: Medium)

1. Implement `infrastructure/src/KVSessionRepository.ts`
2. Implement `infrastructure/src/KVTokenStore.ts`
3. Implement `infrastructure/src/SandboxGitService.ts`
4. Implement `infrastructure/src/SandboxOpencodeService.ts`

### Phase 5: Add Queue Support (Complexity: Medium)

1. Update `wrangler.jsonc` with queue bindings
2. Create `worker/src/queue.ts` queue consumer
3. Update `worker/src/index.ts` to export queue handler
4. Update webhook to enqueue instead of process inline

### Phase 6: Refactor Worker Routes (Complexity: Low)

1. Extract `worker/src/routes/webhook.ts` (thin dispatcher)
2. Extract `worker/src/routes/oauth.ts` (mostly unchanged)
3. Extract `worker/src/routes/health.ts`
4. Extract `worker/src/routes/opencode.ts`
5. Update `worker/src/index.ts` to compose routes

### Phase 7: Simplify Plugin (Complexity: Low)

1. Remove git status checking from plugin
2. Remove continuation prompt logic from plugin
3. Keep only activity streaming
4. Update session.idle to just send Stop signal

### Phase 8: Integration Testing (Complexity: Medium)

1. Test full flow with local wrangler dev
2. Test queue retry behavior
3. Test error scenarios
4. Deploy to staging and test with real Linear

## File-by-File Implementation Details

### `packages/core/package.json`

```json
{
  "name": "@linear-opencode-agent/core",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  }
}
```

### `packages/infrastructure/package.json`

```json
{
  "name": "@linear-opencode-agent/infrastructure",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@linear-opencode-agent/core": "workspace:*",
    "@cloudflare/sandbox": "^0.6.7",
    "@linear/sdk": "^68.1.0",
    "@opencode-ai/sdk": "^1.0.137"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241127.0",
    "typescript": "^5.9.3"
  }
}
```

### `packages/worker/package.json` (updated)

```json
{
  "name": "@linear-opencode-agent/worker",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "@linear-opencode-agent/core": "workspace:*",
    "@linear-opencode-agent/infrastructure": "workspace:*",
    "@cloudflare/sandbox": "^0.6.7",
    "@linear/sdk": "^68.1.0",
    "@opencode-ai/sdk": "^1.0.137"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241127.0",
    "@types/node": "^25.0.3"
  }
}
```

## Error Handling Strategy

### Queue Retries

- `max_retries: 3` with exponential backoff
- After 3 failures, message goes to dead-letter queue (`linear-agent-dlq`)

### Idempotency

Before processing a job:
1. Check if session already exists in KV
2. Check if worktree already exists
3. Skip steps that are already complete

This handles the case where a job is retried after partial completion.

### Error Reporting to Linear

On job failure:
1. Try to post error activity to Linear
2. If that fails, log and let the message go to DLQ
3. DLQ can be monitored for manual intervention

## Testing Strategy

### Unit Tests (packages/core)

- `SessionManager.test.ts` - mock all dependencies
- `JobProcessor.test.ts` - mock all dependencies
- `ActivityReporter.test.ts` - mock Linear client

### Integration Tests (packages/worker)

- Use `wrangler dev --test-scheduled` for queue testing
- Mock external services (Linear API, GitHub)
- Test full webhook → queue → sandbox flow

## Migration Path

1. Deploy new code alongside existing
2. Both webhook paths work (old inline, new queued)
3. Switch webhook URL to new path
4. Monitor for issues
5. Remove old code path

## Success Criteria

- [ ] Webhook responds in <100ms (just enqueue + ack)
- [ ] Queue jobs complete within 2 minutes for new sessions
- [ ] Queue jobs complete within 10 seconds for follow-ups
- [ ] No `IoContext timed out` errors
- [ ] Unit test coverage >80% for core package
- [ ] All existing functionality preserved

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Queue adds latency | User sees "Starting..." activity immediately |
| Queue job fails after partial work | Idempotency checks resume from last good state |
| Plugin simplification breaks something | Test both old and new paths before removing old |
| Package refactor breaks imports | Use TypeScript to catch at compile time |

## Next Steps

1. Review and approve this plan
2. Begin Phase 1: Create Package Structure
3. Iterate through phases with testing at each step
