# Typed Errors Refactor with TaggedError

## Problem Statement

The current implementation has several issues with error handling:

### 1. Using Raw `Error` Type

All `Result<T, E>` types use `Error` as the error type:

```typescript
async postActivity(...): Promise<Result<void, Error>>
async getIssue(issueId: string): Promise<Result<LinearIssue, Error>>
```

This loses all the rich context that Linear's SDK provides through typed error classes.

### 2. Repeated Error-to-String Pattern

In ~12 places throughout the codebase, we have this redundant pattern:

```typescript
const errorMessage =
  typeof abortResult.error === "object" && "message" in abortResult.error
    ? String(abortResult.error.message)
    : JSON.stringify(abortResult.error);
```

This is necessary because:

1. OpenCode SDK returns `{ data, error }` where `error` is an untyped object
2. We don't have proper type guards or error classes

### 3. No Exhaustive Error Matching

Without `TaggedError`, we can't do exhaustive pattern matching on errors:

```typescript
// Can't do this currently:
TaggedError.match(error, {
  NotFoundError: (e) => `Missing: ${e.id}`,
  RateLimitError: (e) => `Retry after: ${e.retryAfter}`,
});
```

---

## Solution: TaggedError Integration

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Error Types                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  packages/core/src/errors/                               │
│  ├── index.ts              # Re-exports all errors       │
│  ├── linear.ts             # Linear-specific errors      │
│  ├── opencode.ts           # OpenCode-specific errors    │
│  └── common.ts             # Shared error utilities      │
│                                                          │
│  Linear Errors (mapped from @linear/sdk):                │
│  ├── LinearNotFoundError                                 │
│  ├── LinearInvalidInputError                             │
│  ├── LinearRateLimitError                                │
│  ├── LinearAuthenticationError                           │
│  ├── LinearForbiddenError                                │
│  ├── LinearNetworkError                                  │
│  └── LinearUnknownError                                  │
│                                                          │
│  OpenCode Errors (mapped from @opencode-ai/sdk):         │
│  ├── OpencodeProviderAuthError                           │
│  ├── OpencodeApiError                                    │
│  ├── OpencodeMessageAbortedError                         │
│  ├── OpencodeMessageOutputLengthError                    │
│  └── OpencodeUnknownError                                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Create Error Type Definitions

**File:** `packages/core/src/errors/linear.ts`

```typescript
import { TaggedError } from "better-result";
import type {
  LinearError,
  LinearGraphQLError,
  InvalidInputLinearError,
  RatelimitedLinearError,
  AuthenticationLinearError,
  ForbiddenLinearError,
  NetworkLinearError,
  FeatureNotAccessibleLinearError,
} from "@linear/sdk";

/**
 * Base context for all Linear errors
 */
interface LinearErrorContext {
  /** Original Linear SDK error */
  cause?: LinearError;
  /** GraphQL errors if available */
  graphqlErrors?: LinearGraphQLError[];
  /** HTTP status code */
  status?: number;
  /** GraphQL query that failed */
  query?: string;
  /** Variables passed to the query */
  variables?: Record<string, unknown>;
}

/**
 * Resource not found in Linear
 */
export class LinearNotFoundError extends TaggedError {
  readonly _tag = "LinearNotFoundError" as const;
  constructor(
    readonly resourceType: string,
    readonly resourceId: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`${resourceType} not found: ${resourceId}`);
  }
}

/**
 * Invalid input provided to Linear API
 */
export class LinearInvalidInputError extends TaggedError {
  readonly _tag = "LinearInvalidInputError" as const;
  constructor(
    readonly field: string,
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Invalid input for ${field}: ${reason}`);
  }
}

/**
 * Rate limited by Linear API
 */
export class LinearRateLimitError extends TaggedError {
  readonly _tag = "LinearRateLimitError" as const;
  constructor(
    readonly retryAfter?: number,
    readonly context?: LinearErrorContext,
  ) {
    super(`Rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""}`);
  }
}

/**
 * Authentication failed with Linear
 */
export class LinearAuthError extends TaggedError {
  readonly _tag = "LinearAuthError" as const;
  constructor(
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Authentication failed: ${reason}`);
  }
}

/**
 * Forbidden - insufficient permissions
 */
export class LinearForbiddenError extends TaggedError {
  readonly _tag = "LinearForbiddenError" as const;
  constructor(
    readonly resource: string,
    readonly action: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Forbidden: cannot ${action} ${resource}`);
  }
}

/**
 * Network error communicating with Linear
 */
export class LinearNetworkError extends TaggedError {
  readonly _tag = "LinearNetworkError" as const;
  constructor(
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Network error: ${reason}`);
  }
}

/**
 * Feature not accessible (plan limitation)
 */
export class LinearFeatureNotAccessibleError extends TaggedError {
  readonly _tag = "LinearFeatureNotAccessibleError" as const;
  constructor(
    readonly feature: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Feature not accessible: ${feature}`);
  }
}

/**
 * Unknown Linear error
 */
export class LinearUnknownError extends TaggedError {
  readonly _tag = "LinearUnknownError" as const;
  constructor(
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Unknown Linear error: ${reason}`);
  }
}

/**
 * Union of all Linear error types
 */
export type LinearServiceError =
  | LinearNotFoundError
  | LinearInvalidInputError
  | LinearRateLimitError
  | LinearAuthError
  | LinearForbiddenError
  | LinearNetworkError
  | LinearFeatureNotAccessibleError
  | LinearUnknownError;

/**
 * Map a Linear SDK error to a TaggedError
 */
export function mapLinearError(error: unknown): LinearServiceError {
  // Import at runtime to avoid circular deps
  const {
    InvalidInputLinearError,
    RatelimitedLinearError,
    AuthenticationLinearError,
    ForbiddenLinearError,
    NetworkLinearError,
    FeatureNotAccessibleLinearError,
    LinearError,
  } = require("@linear/sdk");

  const context: LinearErrorContext = {};

  if (error instanceof LinearError) {
    context.cause = error;
    context.status = error.status;
    context.query = error.query;
    context.variables = error.variables;
    context.graphqlErrors = error.errors;
  }

  if (error instanceof InvalidInputLinearError) {
    const field = error.errors?.[0]?.path?.join(".") ?? "unknown";
    const reason = error.errors?.[0]?.message ?? error.message;
    return new LinearInvalidInputError(field, reason, context);
  }

  if (error instanceof RatelimitedLinearError) {
    // Extract retry-after from headers if available
    return new LinearRateLimitError(undefined, context);
  }

  if (error instanceof AuthenticationLinearError) {
    return new LinearAuthError(error.message, context);
  }

  if (error instanceof ForbiddenLinearError) {
    return new LinearForbiddenError("resource", "access", context);
  }

  if (error instanceof NetworkLinearError) {
    return new LinearNetworkError(error.message, context);
  }

  if (error instanceof FeatureNotAccessibleLinearError) {
    return new LinearFeatureNotAccessibleError("unknown", context);
  }

  // Unknown error
  const message = error instanceof Error ? error.message : String(error);
  return new LinearUnknownError(message, context);
}
```

**File:** `packages/core/src/errors/opencode.ts`

```typescript
import { TaggedError } from "better-result";
import type {
  ProviderAuthError,
  UnknownError,
  MessageOutputLengthError,
  MessageAbortedError,
  ApiError,
} from "@opencode-ai/sdk/v2";

/**
 * OpenCode provider authentication error
 */
export class OpencodeProviderAuthError extends TaggedError {
  readonly _tag = "OpencodeProviderAuthError" as const;
  constructor(
    readonly providerID: string,
    readonly reason: string,
  ) {
    super(`Provider auth failed for ${providerID}: ${reason}`);
  }
}

/**
 * OpenCode API error
 */
export class OpencodeApiError extends TaggedError {
  readonly _tag = "OpencodeApiError" as const;
  constructor(
    readonly statusCode: number | undefined,
    readonly reason: string,
    readonly isRetryable: boolean,
  ) {
    super(`API error${statusCode ? ` (${statusCode})` : ""}: ${reason}`);
  }
}

/**
 * Message was aborted
 */
export class OpencodeMessageAbortedError extends TaggedError {
  readonly _tag = "OpencodeMessageAbortedError" as const;
  constructor(readonly reason: string) {
    super(`Message aborted: ${reason}`);
  }
}

/**
 * Message output exceeded length limit
 */
export class OpencodeOutputLengthError extends TaggedError {
  readonly _tag = "OpencodeOutputLengthError" as const;
  constructor() {
    super("Message output exceeded length limit");
  }
}

/**
 * Unknown OpenCode error
 */
export class OpencodeUnknownError extends TaggedError {
  readonly _tag = "OpencodeUnknownError" as const;
  constructor(readonly reason: string) {
    super(`Unknown OpenCode error: ${reason}`);
  }
}

/**
 * Union of all OpenCode error types
 */
export type OpencodeServiceError =
  | OpencodeProviderAuthError
  | OpencodeApiError
  | OpencodeMessageAbortedError
  | OpencodeOutputLengthError
  | OpencodeUnknownError;

/**
 * OpenCode SDK error object shape
 */
type OpencodeErrorObject =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | ApiError;

/**
 * Map an OpenCode SDK error to a TaggedError
 */
export function mapOpencodeError(error: unknown): OpencodeServiceError {
  // Handle SDK error objects with `name` discriminator
  if (typeof error === "object" && error !== null && "name" in error) {
    const err = error as OpencodeErrorObject;

    switch (err.name) {
      case "ProviderAuthError":
        return new OpencodeProviderAuthError(err.data.providerID, err.data.message);

      case "APIError":
        return new OpencodeApiError(err.data.statusCode, err.data.message, err.data.isRetryable);

      case "MessageAbortedError":
        return new OpencodeMessageAbortedError(err.data.message);

      case "MessageOutputLengthError":
        return new OpencodeOutputLengthError();

      case "UnknownError":
        return new OpencodeUnknownError(err.data.message);
    }
  }

  // Fallback for other error shapes
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);

  return new OpencodeUnknownError(message);
}
```

**File:** `packages/core/src/errors/index.ts`

```typescript
// Re-export all error types and utilities
export * from "./linear";
export * from "./opencode";

// Re-export TaggedError for convenience
export { TaggedError } from "better-result";
```

### Phase 2: Create OpenCode Service Wrapper

**File:** `packages/core/src/opencode/OpencodeService.ts`

```typescript
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import type { OpencodeServiceError } from "../errors";
import { mapOpencodeError } from "../errors";

/**
 * Wrapper around OpenCode SDK that returns Result types with tagged errors
 */
export class OpencodeService {
  constructor(private readonly client: OpencodeClient) {}

  /**
   * Create a worktree
   */
  async createWorktree(
    directory: string,
    name: string,
    startCommand?: string,
  ): Promise<Result<{ directory: string; branch: string }, OpencodeServiceError>> {
    const result = await this.client.worktree.create({
      directory,
      worktreeCreateInput: { name, startCommand },
    });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok({
      directory: result.data.directory,
      branch: result.data.branch,
    });
  }

  /**
   * Get a session by ID
   */
  async getSession(
    sessionID: string,
    directory: string,
  ): Promise<Result<{ id: string }, OpencodeServiceError>> {
    const result = await this.client.session.get({ sessionID, directory });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok({ id: result.data.id });
  }

  /**
   * Create a new session
   */
  async createSession(
    title: string,
    directory: string,
  ): Promise<Result<{ id: string }, OpencodeServiceError>> {
    const result = await this.client.session.create({ title, directory });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok({ id: result.data.id });
  }

  /**
   * Abort a session
   */
  async abortSession(
    sessionID: string,
    directory: string,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.session.abort({ sessionID, directory });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Get session messages
   */
  async getMessages(
    sessionID: string,
    directory: string,
  ): Promise<Result<Array<{ info: unknown; parts: unknown[] }>, OpencodeServiceError>> {
    const result = await this.client.session.messages({ sessionID, directory });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(result.data);
  }

  /**
   * Reply to a permission request
   */
  async replyPermission(
    requestID: string,
    reply: "always" | "once" | "never",
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.permission.reply({ requestID, reply });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Send a prompt to a session
   */
  async prompt(
    sessionID: string,
    directory: string,
    model: { providerID: string; modelID: string },
    parts: Array<{ type: "text"; text: string }>,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.session.prompt({
      sessionID,
      directory,
      model,
      parts,
    });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Subscribe to events (passthrough - returns raw stream)
   */
  subscribe(directory: string) {
    return this.client.event.subscribe({ directory });
  }
}
```

### Phase 3: Update LinearService Interface

**File:** `packages/core/src/linear/LinearService.ts` (updated)

```typescript
import type { Result } from "better-result";
import type { LinearServiceError } from "../errors";
import type { ActivityContent, PlanItem, ProcessingStage, SignalMetadata } from "./types";

// ... existing type definitions ...

export interface LinearService {
  // Activity methods now return LinearServiceError
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
  ): Promise<Result<void, LinearServiceError>>;

  postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void, LinearServiceError>>;

  postError(sessionId: string, error: unknown): Promise<Result<void, LinearServiceError>>;

  // ... etc, all using LinearServiceError ...
}
```

### Phase 4: Update LinearServiceImpl

Use `mapLinearError` in all methods:

```typescript
async postActivity(
  sessionId: string,
  content: ActivityContent,
  ephemeral = false,
): Promise<Result<void, LinearServiceError>> {
  const result = await Result.tryPromise(
    async () => this.client.createAgentActivity({ ... }),
    mapLinearError, // Use mapper for error transformation
  );

  if (Result.isError(result)) {
    this.log.error("Failed to send activity", {
      activityType: content.type,
      sessionId,
      error: result.error.message,
      errorType: result.error._tag,
    });
  }

  return result.map(() => undefined);
}
```

### Phase 5: Use Result.gen for Composition

**Example in EventProcessor:**

```typescript
async process(event: AgentSessionEventWebhookPayload): Promise<Result<void, ProcessError>> {
  const linearSessionId = event.agentSession.id;
  const issue = event.agentSession.issue?.identifier ?? "unknown";

  return Result.gen(async function* () {
    // Create worktree
    yield* Result.await(
      this.linear.postStageActivity(linearSessionId, "git_setup")
    );

    const worktree = yield* Result.await(
      this.opencode.createWorktree(this.repoDirectory, issue, this.config.startCommand)
    );

    // Get or create session
    const session = yield* Result.await(
      this.sessionManager.getOrCreateSession(linearSessionId, issue, worktree.branch, worktree.directory)
    );

    // Handle based on action
    if (event.action === "created") {
      yield* Result.await(this.handleCreated(event, session, worktree));
    } else if (event.action === "prompted") {
      yield* Result.await(this.handlePrompted(event, session, worktree));
    }

    return Result.ok(undefined);
  }.bind(this));
}
```

### Phase 6: Exhaustive Error Matching

**Example usage:**

```typescript
import { TaggedError } from "better-result";

const result = await linearService.getIssue(issueId);

if (Result.isError(result)) {
  const response = TaggedError.match(result.error, {
    LinearNotFoundError: (e) => `Issue ${e.resourceId} not found`,
    LinearRateLimitError: (e) => `Rate limited, retry after ${e.retryAfter}s`,
    LinearAuthError: () => `Authentication required`,
    LinearForbiddenError: (e) => `No permission to ${e.action} ${e.resource}`,
    LinearNetworkError: () => `Network error, please try again`,
    LinearInvalidInputError: (e) => `Invalid ${e.field}: ${e.reason}`,
    LinearFeatureNotAccessibleError: (e) => `Feature ${e.feature} not available on your plan`,
    LinearUnknownError: (e) => `Unknown error: ${e.reason}`,
  });

  await linearService.postError(sessionId, new Error(response));
}
```

---

## Migration Checklist

### Phase 1: Error Types

- [ ] Create `packages/core/src/errors/linear.ts`
- [ ] Create `packages/core/src/errors/opencode.ts`
- [ ] Create `packages/core/src/errors/index.ts`
- [ ] Export errors from `packages/core/src/index.ts`

### Phase 2: OpenCode Service Wrapper

- [ ] Create `packages/core/src/opencode/OpencodeService.ts`
- [ ] Create `packages/core/src/opencode/index.ts`
- [ ] Update exports

### Phase 3: Update LinearService

- [ ] Update `LinearService` interface to use `LinearServiceError`
- [ ] Update `LinearServiceImpl` to use `mapLinearError`
- [ ] Remove `toError` helper function

### Phase 4: Update Consumers

- [ ] Update `EventProcessor` to use `OpencodeService`
- [ ] Update `SessionManager` to use `OpencodeService`
- [ ] Update `SSEEventHandler` to use `OpencodeService`
- [ ] Update `RepoResolver` (already uses LinearService)

### Phase 5: Remove Redundant Patterns

- [ ] Remove all `typeof error === "object" && "message" in error` patterns
- [ ] Remove all manual `JSON.stringify(error)` patterns
- [ ] Use `error.message` or `error._tag` consistently

### Phase 6: Add Result.gen Composition (Optional)

- [ ] Refactor `EventProcessor.process` to use `Result.gen`
- [ ] Refactor `SessionManager.getOrCreateSession` to use `Result.gen`

### Phase 7: Verification

- [ ] Run `bun run check`
- [ ] Test with Docker Compose
- [ ] Verify error messages in Linear UI are readable

---

## Files Changed Summary

| Action     | File                                            |
| ---------- | ----------------------------------------------- |
| **Create** | `packages/core/src/errors/linear.ts`            |
| **Create** | `packages/core/src/errors/opencode.ts`          |
| **Create** | `packages/core/src/errors/index.ts`             |
| **Create** | `packages/core/src/opencode/OpencodeService.ts` |
| **Create** | `packages/core/src/opencode/index.ts`           |
| **Modify** | `packages/core/src/linear/LinearService.ts`     |
| **Modify** | `packages/core/src/linear/LinearServiceImpl.ts` |
| **Modify** | `packages/core/src/EventProcessor.ts`           |
| **Modify** | `packages/core/src/SSEEventHandler.ts`          |
| **Modify** | `packages/core/src/session/SessionManager.ts`   |
| **Modify** | `packages/core/src/index.ts`                    |
| **Modify** | `packages/server/src/index.ts`                  |

---

## Benefits

1. **Type Safety**: Exhaustive error matching ensures all error cases are handled
2. **Rich Context**: Error types carry structured data (IDs, retry times, etc.)
3. **No Raw Strings**: Never need to parse error messages
4. **Composition**: `Result.gen` enables clean async/await-like syntax with automatic error propagation
5. **Logging**: `error._tag` provides consistent error categorization in logs
6. **Testability**: Can easily mock specific error types in tests
