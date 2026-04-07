# Plan: Error Handling Refactor to better-result Best Practices

## Overview

Refactor the codebase to fully adopt `better-result` patterns, eliminating remaining `try/catch` blocks and `throw` statements in business logic.

## Current State

### What's Done Well

- TaggedErrors defined in `packages/core/src/errors/` for Linear and OpenCode
- `Result.tryPromise()` used consistently in service layer (`LinearServiceImpl`, `OpencodeService`)
- `Result.isError()` checks throughout `LinearEventProcessor`
- Error mapping functions (`mapLinearError`, `mapOpencodeError`) convert SDK errors to typed errors

### Violations

| File                                       | Lines               | Issue                                     |
| ------------------------------------------ | ------------------- | ----------------------------------------- |
| `packages/core/src/oauth/handlers.ts`      | 71-73, 305-307, 329 | `throw new Error()` for token failures    |
| `packages/core/src/oauth/handlers.ts`      | 226-284             | Large try/catch block in OAuth callback   |
| `packages/server/src/config.ts`            | 159-161, 170-172    | `throw new Error()` for config validation |
| `packages/core/src/webhook/handlers.ts`    | 71-99               | try/catch for webhook parsing             |
| `packages/server/src/storage/FileStore.ts` | 51-57               | try/catch for JSON parsing                |

### Missing Patterns

- No usage of `Result.gen()` for railway-oriented programming
- OAuth and Config modules lack TaggedError definitions

---

## Phase 1: Define New TaggedErrors

### 1.1 OAuth Errors (`packages/core/src/errors/oauth.ts`)

```typescript
import { TaggedError } from "better-result";

export class TokenExchangeError extends TaggedError("TokenExchangeError")<{
  status: number;
  message: string;
}>() {
  constructor(args: { status: number; body?: string }) {
    super({
      status: args.status,
      message: `Token exchange failed: HTTP ${args.status}${args.body ? ` - ${args.body}` : ""}`,
    });
  }
}

export class TokenRefreshError extends TaggedError("TokenRefreshError")<{
  status: number;
  message: string;
}>() {
  constructor(args: { status: number; body?: string }) {
    super({
      status: args.status,
      message: `Token refresh failed: HTTP ${args.status}${args.body ? ` - ${args.body}` : ""}`,
    });
  }
}

export class MissingRefreshTokenError extends TaggedError("MissingRefreshTokenError")<{
  message: string;
}>() {
  constructor() {
    super({ message: "No refresh token available" });
  }
}

export class OAuthCallbackError extends TaggedError("OAuthCallbackError")<{
  code: string;
  message: string;
}>() {}

export type OAuthError =
  | TokenExchangeError
  | TokenRefreshError
  | MissingRefreshTokenError
  | OAuthCallbackError;
```

**Complexity**: Low
**Files to create**: 1

### 1.2 Config Errors (`packages/server/src/errors/config.ts`)

```typescript
import { TaggedError } from "better-result";

export class ConfigNotFoundError extends TaggedError("ConfigNotFoundError")<{
  searchedPaths: string[];
  message: string;
}>() {
  constructor(args: { searchedPaths: string[] }) {
    super({
      searchedPaths: args.searchedPaths,
      message: `Configuration file not found. Searched: ${args.searchedPaths.join(", ")}`,
    });
  }
}

export class ConfigInvalidError extends TaggedError("ConfigInvalidError")<{
  path: string;
  errors: string[];
  message: string;
}>() {
  constructor(args: { path: string; errors: string[] }) {
    super({
      path: args.path,
      errors: args.errors,
      message: `Invalid configuration at ${args.path}: ${args.errors.join("; ")}`,
    });
  }
}

export class ConfigParseError extends TaggedError("ConfigParseError")<{
  path: string;
  cause: unknown;
  message: string;
}>() {
  constructor(args: { path: string; cause: unknown }) {
    const msg = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({
      path: args.path,
      cause: args.cause,
      message: `Failed to parse config at ${args.path}: ${msg}`,
    });
  }
}

export type ConfigError = ConfigNotFoundError | ConfigInvalidError | ConfigParseError;
```

**Complexity**: Low
**Files to create**: 1

---

## Phase 2: Refactor OAuth Handlers

### 2.1 Update `exchangeCodeForToken()`

**File**: `packages/core/src/oauth/handlers.ts`

**Current**:

```typescript
async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch("https://api.linear.app/oauth/token", { ... });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }
  const data = await response.json();
  return { ... };
}
```

**Refactored**:

```typescript
async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<Result<TokenData, TokenExchangeError>> {
  return Result.tryPromise({
    try: async () => {
      const response = await fetch("https://api.linear.app/oauth/token", { ... });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return Result.err(new TokenExchangeError({ status: response.status, body }));
      }
      const data = await response.json();
      return Result.ok({ accessToken: data.access_token, ... });
    },
    catch: (e) => new TokenExchangeError({ status: 0, body: String(e) }),
  });
}
```

**Complexity**: Medium
**Changes**: Function signature, error handling

### 2.2 Update `refreshAccessToken()`

**Current**:

```typescript
async function refreshAccessToken(...): Promise<{ ... }> {
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }
  const response = await fetch(...);
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  // ...
}
```

**Refactored**:

```typescript
async function refreshAccessToken(
  ...
): Promise<Result<TokenData, TokenRefreshError | MissingRefreshTokenError>> {
  if (!refreshToken) {
    return Result.err(new MissingRefreshTokenError());
  }
  return Result.tryPromise({
    try: async () => {
      const response = await fetch(...);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return Result.err(new TokenRefreshError({ status: response.status, body }));
      }
      // ...
      return Result.ok({ ... });
    },
    catch: (e) => new TokenRefreshError({ status: 0, body: String(e) }),
  });
}
```

**Complexity**: Medium

### 2.3 Update `handleOAuthCallback()`

Replace the large try/catch block with Result-based flow.

**Current** (lines 226-284):

```typescript
export async function handleOAuthCallback(...): Promise<Response> {
  try {
    // ... lots of logic
    const tokens = await exchangeCodeForToken(...);
    // ... more logic
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(`OAuth error: ${message}`, { status: 500 });
  }
}
```

**Refactored**:

```typescript
export async function handleOAuthCallback(...): Promise<Response> {
  const tokensResult = await exchangeCodeForToken(...);
  if (Result.isError(tokensResult)) {
    return new Response(`OAuth error: ${tokensResult.error.message}`, { status: 500 });
  }
  const tokens = tokensResult.value;
  // ... continue with Result-based flow
}
```

**Complexity**: Medium-High (large function)

### 2.4 Update Callers

Files that call OAuth functions need to handle Result returns:

- `packages/core/src/oauth/handlers.ts` (internal calls)
- `packages/server/src/index.ts` (OAuth routes)

**Complexity**: Low

---

## Phase 3: Refactor Config Loading

### 3.1 Update `loadConfig()`

**File**: `packages/server/src/config.ts`

**Current**:

```typescript
export async function loadConfig(configPath?: string): Promise<Config> {
  // ... find config file
  if (!configFile) {
    throw new Error(`Configuration file not found...`);
  }
  // ... parse and validate
  if (!parseResult.success) {
    throw new Error(`Invalid configuration...`);
  }
  return config;
}
```

**Refactored**:

```typescript
export async function loadConfig(configPath?: string): Promise<Result<Config, ConfigError>> {
  // ... find config file
  if (!configFile) {
    return Result.err(new ConfigNotFoundError({ searchedPaths }));
  }

  const parseResult = Result.try({
    try: () => JSON.parse(content),
    catch: (e) => new ConfigParseError({ path: configFile, cause: e }),
  });
  if (Result.isError(parseResult)) {
    return parseResult;
  }

  const validateResult = configSchema.safeParse(parseResult.value);
  if (!validateResult.success) {
    return Result.err(
      new ConfigInvalidError({
        path: configFile,
        errors: validateResult.error.errors.map((e) => e.message),
      }),
    );
  }

  return Result.ok(validateResult.data);
}
```

**Complexity**: Medium

### 3.2 Update Server Entry Point

**File**: `packages/server/src/index.ts`

**Current**:

```typescript
async function main() {
  const config = await loadConfig();
  // ...
}
main().catch(console.error);
```

**Refactored**:

```typescript
async function main(): Promise<void> {
  const configResult = await loadConfig();
  if (Result.isError(configResult)) {
    console.error(configResult.error.message);
    process.exit(1);
  }
  const config = configResult.value;
  // ...
}
main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
```

**Complexity**: Low

---

## Phase 4: Wrap External SDK Calls

### 4.1 Webhook Verification

**File**: `packages/core/src/webhook/handlers.ts`

**Current** (lines 71-99):

```typescript
try {
  const parsed = webhookClient.parseData(rawBody, signature, timestamp);
  // ...
} catch (error) {
  return new Response("Invalid webhook", { status: 400 });
}
```

**Refactored**:

```typescript
const parseResult = Result.try({
  try: () => webhookClient.parseData(rawBody, signature, timestamp),
  catch: (e) => new WebhookVerificationError({ cause: e }),
});

if (Result.isError(parseResult)) {
  log.warn("Webhook verification failed", { error: parseResult.error.message });
  return new Response("Invalid webhook", { status: 400 });
}
const parsed = parseResult.value;
```

**Complexity**: Low

### 4.2 FileStore JSON Parsing

**File**: `packages/server/src/storage/FileStore.ts`

**Current** (lines 51-57):

```typescript
try {
  this.data = JSON.parse(content);
} catch {
  this.data = {};
}
```

**Refactored**:

```typescript
const parseResult = Result.try({
  try: () => JSON.parse(content) as StoreData,
  catch: () => null,
});
this.data = parseResult.status === "ok" ? parseResult.value : {};
```

**Complexity**: Low

---

## Phase 5: Adopt Result.gen() (Optional)

### 5.1 LinearEventProcessor.handleCreated()

**File**: `packages/core/src/LinearEventProcessor.ts`

**Current pattern**:

```typescript
async handleCreated(event: ..., log: Logger): Promise<void> {
  const worktreeResult = await this.worktreeManager.resolveWorktree(...);
  if (Result.isError(worktreeResult)) {
    await this.linear.postError(linearSessionId, worktreeResult.error);
    return;
  }
  const { workdir, branchName } = worktreeResult.value;

  const sessionResult = await this.sessionManager.getOrCreateSession(...);
  if (Result.isError(sessionResult)) {
    await this.linear.postError(linearSessionId, sessionResult.error);
    return;
  }
  const session = sessionResult.value;

  // ... more steps
}
```

**Refactored with Result.gen()**:

```typescript
async handleCreated(event: ..., log: Logger): Promise<void> {
  const result = await Result.gen(async function* () {
    const { workdir, branchName } = yield* Result.await(
      this.worktreeManager.resolveWorktree(...)
    );
    const session = yield* Result.await(
      this.sessionManager.getOrCreateSession(...)
    );
    // ... more steps
    return Result.ok({ workdir, branchName, session });
  }.bind(this));

  if (Result.isError(result)) {
    await this.linear.postError(linearSessionId, result.error);
    return;
  }

  // Use result.value
}
```

**Complexity**: Medium
**Benefit**: Cleaner railway-oriented flow, reduces boilerplate
**Risk**: Team unfamiliarity with generator pattern

---

## Implementation Order

| Phase | Task                                       | Complexity  | Priority       |
| ----- | ------------------------------------------ | ----------- | -------------- |
| 1.1   | Create OAuth TaggedErrors                  | Low         | High           |
| 1.2   | Create Config TaggedErrors                 | Low         | High           |
| 2.1   | Refactor `exchangeCodeForToken()`          | Medium      | High           |
| 2.2   | Refactor `refreshAccessToken()`            | Medium      | High           |
| 2.3   | Refactor `handleOAuthCallback()`           | Medium-High | High           |
| 2.4   | Update OAuth callers                       | Low         | High           |
| 3.1   | Refactor `loadConfig()`                    | Medium      | High           |
| 3.2   | Update server entry point                  | Low         | High           |
| 4.1   | Wrap webhook verification                  | Low         | Medium         |
| 4.2   | Wrap FileStore JSON parsing                | Low         | Low            |
| 5.1   | Adopt Result.gen() in LinearEventProcessor | Medium      | Low (optional) |

---

## Testing Strategy

1. **Unit tests for new TaggedErrors**
   - Verify `_tag` discriminator is correct
   - Verify error messages format correctly
   - Test `Error.is()` type guards

2. **Integration tests for refactored functions**
   - OAuth token exchange success/failure paths
   - Config loading with missing/invalid files
   - Webhook verification with invalid signatures

3. **Regression tests**
   - Ensure existing behavior unchanged
   - End-to-end Linear webhook → OpenCode session flow

---

## Success Criteria

- [ ] Zero `throw new Error()` statements in business logic
- [ ] Zero `try/catch` blocks except for:
  - Top-level process error handlers
  - Fire-and-forget background tasks (with logging)
- [ ] All service functions return `Result<T, E>`
- [ ] All errors extend `TaggedError` with `_tag` discriminator
- [ ] `bun run check` passes
- [ ] All existing tests pass

---

## Files Changed Summary

| Package | Files Modified | Files Created |
| ------- | -------------- | ------------- |
| core    | 3              | 1             |
| server  | 3              | 1             |
| oauth   | 0              | 0             |

**Total**: 6 files modified, 2 files created
