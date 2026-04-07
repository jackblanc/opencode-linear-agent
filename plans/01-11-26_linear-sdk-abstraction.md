# Linear SDK Abstraction & Result Type Standardization

## Dependencies

This plan uses the `better-result` package for Result types:

- **Package:** `better-result` (npm)
- **Repository:** https://github.com/dmmulroy/better-result
- **Why:** Standardized Result type across multiple repositories, avoiding redefinition

## Problem Statement

### 1. Linear SDK Proliferation

The `LinearClient` from `@linear/sdk` is instantiated in **4 different places**:

| Location                            | Purpose                                          |
| ----------------------------------- | ------------------------------------------------ |
| `LinearClientAdapter` (constructor) | Agent activities                                 |
| `server/src/index.ts`               | `RepoResolver`                                   |
| `oauth/handlers.ts`                 | Token validation / org info                      |
| `webhook/handlers.ts`               | `LinearWebhookClient` for signature verification |

This violates single responsibility and makes the codebase harder to maintain.

### 2. Inconsistent Error Handling

| SDK          | Error Behavior                                | Current Pattern                         |
| ------------ | --------------------------------------------- | --------------------------------------- |
| **OpenCode** | Returns `{ data, error }` discriminated union | Incorrectly using try/catch in 4 places |
| **Linear**   | Throws exceptions                             | Correctly using try/catch               |

We want a standardized approach using discriminated unions (Result types) for both.

### 3. Unnecessary OpenCode try/catch Blocks

The OpenCode SDK uses `throwOnError: false` by default. These try/catch blocks are unnecessary:

- `SessionManager.ts:101-157` - `session.get()`
- `SessionManager.ts:180-196` - `session.messages()`
- `SSEEventHandler.ts:459-472` - `permission.reply()`
- `EventProcessor.ts:124-240` - `worktree.create()` (wrapped in larger try/catch)

### 4. Why RepoResolver Needs Linear API

The webhook payload (`AgentSessionEventWebhookPayload`) does **NOT** include:

- Labels (needed for `repo:xyz` routing)
- Attachments (fallback for GitHub links)

The `IssueWithDescriptionChildWebhookPayload` only provides:

```typescript
{
  id: string;
  identifier: string;  // e.g., "CODE-123"
  title: string;
  description?: string;
  url: string;
  team: { id, key, name };
}
```

So `RepoResolver` must call the Linear API to fetch labels/attachments.

---

## Solution: Unified LinearService with Result Types

### Architecture Overview

```
Entry Point (server/src/index.ts)
    │
    ├── Creates LinearClient (single instance)
    │
    └── Creates LinearService (wraps LinearClient)
        │
        ├── Activity methods → Result<void>
        │   ├── postActivity()
        │   ├── postStageActivity()
        │   ├── postError()
        │   ├── postElicitation()
        │   ├── setExternalLink()
        │   └── updatePlan()
        │
        └── Query methods → Result<T>
            ├── getIssue()
            ├── getIssueLabels()
            └── getIssueAttachments()

RepoResolver
    │
    └── Uses LinearService (not raw LinearClient)
        └── Pure logic: receives data, returns routing decision

OAuth Handlers (unchanged)
    │
    └── Creates own LinearClient (acceptable - one-time setup flow)

Webhook Verification (unchanged)
    │
    └── LinearWebhookClient (stateless, just needs secret)
```

---

## Implementation Plan

### Phase 1: Add `better-result` Dependency

**File:** `packages/core/package.json`

```bash
cd packages/core && bun add better-result
```

The `better-result` package provides:

- `Result<T, E>` - Discriminated union type (`Ok<T, E> | Err<T, E>`)
- `Result.ok(value)` - Create success result
- `Result.err(error)` - Create error result
- `Result.isOk(result)` - Type guard for success
- `Result.isError(result)` - Type guard for error
- `Result.tryPromise(fn)` - Wrap async throwing function in Result
- `Result.try(fn)` - Wrap sync throwing function in Result
- `.unwrap()` - Extract value or throw
- `.unwrapOr(fallback)` - Extract value or return fallback
- `.map(fn)` - Transform success value
- `.mapError(fn)` - Transform error value
- `.match({ ok, err })` - Pattern match on result

**Key difference from OpenCode SDK pattern:**

- OpenCode returns `{ data, error }` plain objects
- `better-result` returns `Ok`/`Err` class instances with methods
- Use `Result.isOk(result)` then `result.value` (not `result.data`)
- Use `Result.isError(result)` then `result.error`

### Phase 2: Create LinearService Interface

**File:** `packages/core/src/linear/LinearService.ts`

```typescript
import type { Result } from "better-result";
import type { ActivityContent, PlanItem, ProcessingStage, SignalMetadata } from "./types";
import type { ElicitationSignal } from "./LinearAdapter";

/**
 * Issue data returned from Linear API
 */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
}

/**
 * Label data returned from Linear API
 */
export interface LinearLabel {
  id: string;
  name: string;
}

/**
 * Attachment data returned from Linear API
 */
export interface LinearAttachment {
  id: string;
  url?: string;
  title?: string;
}

/**
 * Unified interface for all Linear operations.
 *
 * Wraps the Linear SDK client and returns Result types
 * instead of throwing exceptions.
 */
export interface LinearService {
  // ─────────────────────────────────────────────────────────────
  // Agent Activity Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Post an activity to a Linear session
   */
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
  ): Promise<Result<void>>;

  /**
   * Post a processing stage activity (ephemeral thought)
   */
  postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void>>;

  /**
   * Post an error activity to a Linear session
   */
  postError(sessionId: string, error: unknown): Promise<Result<void>>;

  /**
   * Post an elicitation activity to request user input
   */
  postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void>>;

  /**
   * Set the external link for a Linear session
   */
  setExternalLink(sessionId: string, url: string): Promise<Result<void>>;

  /**
   * Update the plan for a Linear session
   */
  updatePlan(sessionId: string, plan: PlanItem[]): Promise<Result<void>>;

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Get an issue by ID
   */
  getIssue(issueId: string): Promise<Result<LinearIssue>>;

  /**
   * Get labels for an issue
   */
  getIssueLabels(issueId: string): Promise<Result<LinearLabel[]>>;

  /**
   * Get attachments for an issue
   */
  getIssueAttachments(issueId: string): Promise<Result<LinearAttachment[]>>;
}
```

### Phase 3: Implement LinearServiceImpl

**File:** `packages/core/src/linear/LinearServiceImpl.ts`

```typescript
import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import { Result } from "better-result";
import type { LinearService, LinearIssue, LinearLabel, LinearAttachment } from "./LinearService";
import type { ActivityContent, PlanItem, ProcessingStage, SignalMetadata } from "./types";
import { STAGE_MESSAGES } from "./types";
import type { ElicitationSignal } from "./LinearAdapter";
import { Log, type Logger } from "../logger";

function mapElicitationSignal(signal: ElicitationSignal): AgentActivitySignal | undefined {
  switch (signal) {
    case "auth":
      return AgentActivitySignal.Auth;
    case "select":
      return AgentActivitySignal.Select;
    default:
      return undefined;
  }
}

/**
 * Linear SDK implementation of LinearService
 */
export class LinearServiceImpl implements LinearService {
  private readonly client: LinearClient;
  private readonly log: Logger;

  constructor(accessToken: string) {
    this.client = new LinearClient({ accessToken });
    this.log = Log.create({ service: "linear" });
  }

  // ─────────────────────────────────────────────────────────────
  // Agent Activity Methods
  // ─────────────────────────────────────────────────────────────

  async postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral = false,
  ): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(() =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content,
        ephemeral,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to send activity", {
        activityType: content.type,
        sessionId,
        ephemeral,
        error: result.error.message,
      });
      return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
    }

    return Result.ok(undefined);
  }

  async postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void, Error>> {
    const baseMessage = STAGE_MESSAGES[stage];
    const body = details ? `${baseMessage}\n\n${details}` : baseMessage;

    const result = await Result.tryPromise(() =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: { type: "thought", body },
        ephemeral: true,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to send stage activity", {
        processingStage: stage,
        sessionId,
        error: result.error.message,
      });
      return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
    }

    return Result.ok(undefined);
  }

  async postError(sessionId: string, error: unknown): Promise<Result<void, Error>> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const truncatedStack = errorStack ? errorStack.split("\n").slice(0, 20).join("\n") : undefined;

    const errorBody = truncatedStack
      ? `**Error:** ${errorMessage}\n\n**Stack trace:**\n\`\`\`\n${truncatedStack}\n\`\`\``
      : `**Error:** ${errorMessage}`;

    const result = await Result.tryPromise(() =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: { type: "error", body: errorBody },
        ephemeral: false,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to report error to Linear", {
        sessionId,
        originalError: errorMessage,
        reportError: result.error.message,
      });
      return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
    }

    return Result.ok(undefined);
  }

  async postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(() =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "elicitation",
          body,
          signalMetadata: metadata,
        },
        signal: mapElicitationSignal(signal),
        ephemeral: false,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to send elicitation", {
        sessionId,
        signal,
        error: result.error.message,
      });
      return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
    }

    return Result.ok(undefined);
  }

  async setExternalLink(sessionId: string, url: string): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(async () => {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ externalLink: url });
    });

    if (Result.isError(result)) {
      this.log.error("Failed to set external link", {
        sessionId,
        url,
        error: result.error.message,
      });
      return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
    }

    return Result.ok(undefined);
  }

  async updatePlan(sessionId: string, plan: PlanItem[]): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(async () => {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ plan });
    });

    if (Result.isError(result)) {
      this.log.error("Failed to update plan", {
        sessionId,
        planItemCount: plan.length,
        error: result.error.message,
      });
      return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
    }

    return Result.ok(undefined);
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  async getIssue(issueId: string): Promise<Result<LinearIssue, Error>> {
    const result = await Result.tryPromise(async () => {
      const issue = await this.client.issue(issueId);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
      };
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue", {
        issueId,
        error: result.error.message,
      });
    }

    return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
  }

  async getIssueLabels(issueId: string): Promise<Result<LinearLabel[], Error>> {
    const result = await Result.tryPromise(async () => {
      const issue = await this.client.issue(issueId);
      const labels = await issue.labels();
      return labels.nodes.map((label) => ({
        id: label.id,
        name: label.name,
      }));
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue labels", {
        issueId,
        error: result.error.message,
      });
    }

    return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
  }

  async getIssueAttachments(issueId: string): Promise<Result<LinearAttachment[], Error>> {
    const result = await Result.tryPromise(async () => {
      const issue = await this.client.issue(issueId);
      const attachments = await issue.attachments();
      return attachments.nodes.map((attachment) => ({
        id: attachment.id,
        url: attachment.url ?? undefined,
        title: attachment.title,
      }));
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue attachments", {
        issueId,
        error: result.error.message,
      });
    }

    return result.mapError((e) => (e instanceof Error ? e : new Error(String(e))));
  }
}
```

### Phase 4: Update RepoResolver

**File:** `packages/server/src/RepoResolver.ts`

Change from:

```typescript
constructor(
  private readonly linearClient: LinearClient,
  ...
)
```

To:

```typescript
constructor(
  private readonly linear: LinearService,
  ...
)
```

And update `resolve()` to use `LinearService` methods:

```typescript
import { Result } from "better-result";

async resolve(issueId: string): Promise<Result<ResolvedRepo | null, Error>> {
  const log = Log.create({ service: "repo-resolver" }).tag("issueId", issueId);

  // Strategy 1: Check labels for "repo:" label
  const labelsResult = await this.linear.getIssueLabels(issueId);
  if (Result.isError(labelsResult)) {
    return labelsResult;
  }

  const repoLabelInfo = parseRepoLabel(labelsResult.value);
  if (repoLabelInfo) {
    const resolved = this.findRepoByName(repoLabelInfo.repositoryName);
    if (resolved) {
      log.info("Resolved repo from label", { ... });
      return Result.ok(resolved);
    }
    // ... rest of label handling
  }

  // Strategy 2: Check attachments
  const attachmentsResult = await this.linear.getIssueAttachments(issueId);
  if (Result.isError(attachmentsResult)) {
    return attachmentsResult;
  }

  for (const attachment of attachmentsResult.value) {
    // ... existing logic
  }

  // Strategy 3: Check description (need to fetch issue)
  const issueResult = await this.linear.getIssue(issueId);
  if (Result.isError(issueResult)) {
    return issueResult;
  }

  const description = issueResult.value.description ?? "";
  // ... existing description parsing logic

  // Strategy 4: Fall back to default
  // ... existing fallback logic

  return Result.ok(null);
}
```

### Phase 5: Update Entry Point

**File:** `packages/server/src/index.ts`

Change from:

```typescript
const linearAdapter = new LinearClientAdapter(accessToken);
const linearClient = new LinearClient({ accessToken });
const repoResolver = RepoResolver.fromConfig(linearClient, config);
```

To:

```typescript
const linearService = new LinearServiceImpl(accessToken);
const repoResolver = RepoResolver.fromConfig(linearService, config);
```

And pass `linearService` to `EventProcessor` instead of `linearAdapter`.

### Phase 6: Remove Unnecessary try/catch in OpenCode Calls

#### SessionManager.ts

**Before (lines 101-157):**

```typescript
try {
  const session = await this.opcodeClient.session.get({ ... });
  if (session.data) { ... }
} catch (error) {
  // recovery logic
}
```

**After:**

```typescript
const session = await this.opcodeClient.session.get({ ... });
if (session.data) {
  // success path
} else if (session.error) {
  // error path - same recovery logic, no try/catch
  const errorMessage = session.error.message ?? String(session.error);
  log.warn("Failed to resume session, fetching previous context", { error: errorMessage });
  // ... recovery logic
}
```

#### SSEEventHandler.ts

**Before (lines 459-472):**

```typescript
try {
  await this.opcodeClient.permission.reply({ ... });
} catch (error) {
  this.log.error("Failed to reply to permission", { ... });
}
```

**After:**

```typescript
const result = await this.opcodeClient.permission.reply({ ... });
if (result.error) {
  this.log.error("Failed to reply to permission", {
    requestId: id,
    error: result.error.message ?? String(result.error),
  });
}
```

#### EventProcessor.ts

The try/catch at lines 124-240 wraps multiple operations including Linear calls.
Keep the outer structure but handle OpenCode errors via `.error` field:

```typescript
// Handle worktree creation without try/catch
const worktreeResult = await this.opencodeClient.worktree.create({ ... });
if (worktreeResult.error) {
  const errorDetails = worktreeResult.error.errors
    ?.map((e) => typeof e === "object" ? JSON.stringify(e) : String(e))
    .join("; ") ?? "no data returned";

  // Report to Linear and return early
  await this.linear.postError(linearSessionId, new Error(`Failed to create worktree: ${errorDetails}`));
  throw new Error(`Failed to create worktree: ${errorDetails}`);
}
```

### Phase 7: Delete Old LinearClientAdapter

Once `LinearServiceImpl` is working, delete:

- `packages/core/src/linear/LinearClientAdapter.ts`
- Update `packages/core/src/linear/LinearAdapter.ts` (interface) - either delete or keep as alias

### Phase 8: Update Exports

**File:** `packages/core/src/index.ts`

```typescript
// Re-export Result from better-result for convenience
export { Result } from "better-result";

// Linear service
export type {
  LinearService,
  LinearIssue,
  LinearLabel,
  LinearAttachment,
} from "./linear/LinearService";
export { LinearServiceImpl } from "./linear/LinearServiceImpl";

// Remove old exports
// export { LinearClientAdapter } from "./linear/LinearClientAdapter";
// export type { LinearAdapter } from "./linear/LinearAdapter";
```

---

## Migration Checklist

- [ ] Add `better-result` dependency to `packages/core/package.json`
- [ ] Create `packages/core/src/linear/LinearService.ts` interface
- [ ] Create `packages/core/src/linear/LinearServiceImpl.ts` implementation
- [ ] Update `packages/server/src/RepoResolver.ts` to use LinearService
- [ ] Update `packages/server/src/index.ts` to instantiate LinearServiceImpl
- [ ] Update `packages/core/src/EventProcessor.ts` to accept LinearService
- [ ] Update `packages/core/src/SSEEventHandler.ts` to accept LinearService
- [ ] Remove try/catch from `SessionManager.ts` (2 places)
- [ ] Remove try/catch from `SSEEventHandler.ts` (1 place)
- [ ] Refactor try/catch in `EventProcessor.ts` for OpenCode calls
- [ ] Delete `LinearClientAdapter.ts`
- [ ] Delete or deprecate `LinearAdapter.ts` interface
- [ ] Update exports in `packages/core/src/index.ts`
- [ ] Run `bun run check` to verify types
- [ ] Test with Docker Compose

---

## Files Changed Summary

| Action     | File                                               |
| ---------- | -------------------------------------------------- |
| **Modify** | `packages/core/package.json` (add `better-result`) |
| **Create** | `packages/core/src/linear/LinearService.ts`        |
| **Create** | `packages/core/src/linear/LinearServiceImpl.ts`    |
| **Modify** | `packages/server/src/RepoResolver.ts`              |
| **Modify** | `packages/server/src/index.ts`                     |
| **Modify** | `packages/core/src/EventProcessor.ts`              |
| **Modify** | `packages/core/src/SSEEventHandler.ts`             |
| **Modify** | `packages/core/src/session/SessionManager.ts`      |
| **Modify** | `packages/core/src/index.ts`                       |
| **Delete** | `packages/core/src/linear/LinearClientAdapter.ts`  |
| **Delete** | `packages/core/src/linear/LinearAdapter.ts`        |

---

## Not Changed (Acceptable)

| File                                    | Reason                                          |
| --------------------------------------- | ----------------------------------------------- |
| `packages/core/src/oauth/handlers.ts`   | One-time setup flow, creates own client         |
| `packages/core/src/webhook/handlers.ts` | `LinearWebhookClient` is stateless verification |

---

## `better-result` API Quick Reference

### Creating Results

```typescript
import { Result } from "better-result";

// Success
const success = Result.ok(42); // Ok<number, never>
const success2 = Result.ok(undefined); // Ok<void, never> for void returns

// Error
const failure = Result.err(new Error("failed")); // Err<never, Error>

// Wrap throwing function (sync)
const result = Result.try(() => JSON.parse(str));

// Wrap throwing function (async)
const result = await Result.tryPromise(() => fetch(url));

// With custom error mapping
const result = Result.try({
  try: () => JSON.parse(str),
  catch: (e) => new ParseError(e),
});
```

### Checking Results

```typescript
// Type guards
if (Result.isOk(result)) {
  console.log(result.value); // Access .value on Ok
}

if (Result.isError(result)) {
  console.log(result.error); // Access .error on Err
}

// Pattern matching
const message = result.match({
  ok: (value) => `Got: ${value}`,
  err: (error) => `Failed: ${error.message}`,
});
```

### Extracting Values

```typescript
// Unwrap (throws if Err)
const value = result.unwrap();
const value = result.unwrap("custom error message");

// Unwrap with fallback
const value = result.unwrapOr(defaultValue);
```

### Transforming Results

```typescript
// Transform success value
const doubled = result.map((x) => x * 2);

// Transform error
const mapped = result.mapError((e) => new WrappedError(e));

// Chain Result-returning functions
const chained = result.andThen((x) => (x > 0 ? Result.ok(x) : Result.err(new Error("negative"))));
```

### Key Differences from OpenCode SDK

| OpenCode SDK                    | `better-result`                                   |
| ------------------------------- | ------------------------------------------------- |
| `{ data: T, error: undefined }` | `Ok<T, E>` class with `.value`                    |
| `{ data: undefined, error: E }` | `Err<T, E>` class with `.error`                   |
| `result.data`                   | `result.value` (only on Ok)                       |
| `result.error`                  | `result.error` (only on Err)                      |
| Plain objects                   | Class instances with methods                      |
| No transformation methods       | `.map()`, `.mapError()`, `.andThen()`, `.match()` |
