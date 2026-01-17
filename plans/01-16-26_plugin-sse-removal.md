# Plugin Architecture: Remove SSE, Use Plugin for Event Handling

**Date**: 2026-01-16
**Status**: In Progress

## Decisions

- **Ephemeral state**: Keep in-memory for deduplication (`runningTools`, `sentTextParts`, etc.)
- **OpencodeEventProcessor**: Remove entirely (plugin handles everything)
- **Test scope**: Include tests for all complex logic (handlers, parser, storage, state)

## Overview

Refactor the architecture to remove SSE-based event handling from the server. The OpenCode plugin will handle all real-time event streaming to Linear, while the server becomes a stateless webhook handler that:

1. Receives Linear webhooks
2. Sends prompts to OpenCode (fire-and-forget)
3. Handles question/permission responses by reading shared state

This enables future deployment to Cloudflare Workers (serverless) where long-running SSE connections aren't feasible.

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Webhook Server                                              │
│                                                             │
│  LinearEventProcessor                                       │
│  - Receives webhooks                                        │
│  - Sends prompts to OpenCode                                │
│  - Subscribes to SSE stream (BLOCKS)                        │
│  - Posts activities to Linear via OpencodeEventProcessor    │
│  - Saves pending questions/permissions                      │
└─────────────────────────────────────────────────────────────┘
         │
         │ SSE subscription (long-running)
         ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenCode Server                                             │
│                                                             │
│  Plugin (currently duplicates server functionality)         │
│  - Also posts activities to Linear                          │
│  - Also saves pending questions/permissions                 │
│  - Uses different storage key prefixes (BUG)                │
└─────────────────────────────────────────────────────────────┘
```

**Problems:**

1. SSE blocks the webhook handler (incompatible with serverless)
2. Duplicate event handling (server + plugin both post to Linear)
3. Storage key prefix mismatch (plugin writes `pending:question:`, server reads `question:`)
4. Plugin uses in-memory session state instead of shared file storage

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Webhook Server (Stateless)                                  │
│                                                             │
│  LinearEventProcessor                                       │
│  - Receives webhooks                                        │
│  - Sends prompts to OpenCode (fire-and-forget)              │
│  - Reads shared state for pending questions/permissions     │
│  - Replies to OpenCode when user responds                   │
│                                                             │
│  OpencodeEventProcessor (logging only)                      │
│  - Optionally subscribe to SSE for debugging/observability  │
│  - Does NOT post to Linear (plugin does this)               │
└─────────────────────────────────────────────────────────────┘
         │
         │ prompt() / replyQuestion() / replyPermission()
         ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenCode Server                                             │
│                                                             │
│  Plugin (sole owner of Linear activity streaming)           │
│  - Posts all activities to Linear                           │
│  - Posts plan updates to Linear                             │
│  - Saves pending questions/permissions to shared store      │
│  - Writes session state to shared file store                │
└─────────────────────────────────────────────────────────────┘
         │
         │ Shared file storage
         ▼
┌─────────────────────────────────────────────────────────────┐
│ store.json                                                  │
│                                                             │
│  - token:access:{orgId} - OAuth tokens                      │
│  - token:refresh:{orgId} - Refresh tokens                   │
│  - session:{linearSessionId} - Session state                │
│  - question:{linearSessionId} - Pending questions           │
│  - permission:{linearSessionId} - Pending permissions       │
└─────────────────────────────────────────────────────────────┘
```

## Event Flow

### Session Created (webhook)

```
1. Linear sends webhook (action: created)
2. Server creates worktree, OpenCode session
3. Server builds prompt with frontmatter (session ID, issue ID, store path, etc.)
4. Server calls opencode.prompt() - returns immediately
5. Server returns HTTP 200 to Linear

6. OpenCode processes prompt...
7. Plugin receives events, posts activities to Linear
8. If question asked: Plugin saves to store.json, OpenCode waits
9. If permission asked: Plugin saves to store.json, OpenCode waits
10. On completion: Plugin posts final response to Linear
```

### User Responds to Question (webhook)

```
1. Linear sends webhook (action: prompted)
2. Server reads pending question from store.json
3. Server calls opencode.replyQuestion()
4. Server returns HTTP 200 to Linear

5. OpenCode continues processing...
6. (Back to step 7 above)
```

### User Responds to Permission (webhook)

```
1. Linear sends webhook (action: prompted)
2. Server reads pending permission from store.json
3. Server calls opencode.replyPermission()
4. Server returns HTTP 200 to Linear

5. OpenCode continues processing...
6. (Back to step 7 above)
```

## Implementation Plan

### Phase 1: Fix Plugin Bugs

**Goal**: Make plugin compatible with server's storage format

#### 1.1 Fix storage key prefix mismatch

**File**: `packages/plugin/src/storage.ts`

Change:

```typescript
const PENDING_QUESTION_PREFIX = "pending:question:";
const PENDING_PERMISSION_PREFIX = "pending:permission:";
```

To:

```typescript
const PENDING_QUESTION_PREFIX = "question:";
const PENDING_PERMISSION_PREFIX = "permission:";
```

#### 1.2 Session state approach

**Ephemeral state** (in-memory, `packages/plugin/src/state.ts`):

- `runningTools: Set<string>` - deduplication for tool activities
- `sentTextParts: Set<string>` - deduplication for text responses
- `postedFinalResponse: boolean` - prevent duplicate completion messages
- `postedError: boolean` - prevent duplicate error messages

This state is per-process and doesn't need to persist. Keep current in-memory implementation.

**Persistent state** (file-based, shared with server):

- Pending questions: `question:{linearSessionId}`
- Pending permissions: `permission:{linearSessionId}`
- OAuth tokens: `token:access:{orgId}`, `token:refresh:{orgId}`

Already handled by `packages/plugin/src/storage.ts` (after key prefix fix).

### Phase 2: Add Plugin Tests

**Goal**: Ensure plugin works correctly before removing SSE

#### 2.1 Parser tests

**File**: `packages/plugin/test/parser.test.ts`

Test cases:

- Parse valid frontmatter with all fields
- Parse frontmatter with optional sessionId missing
- Handle missing required fields
- Handle malformed YAML
- Handle no frontmatter

#### 2.2 Storage tests

**File**: `packages/plugin/test/storage.test.ts`

Test cases:

- Save and read pending question
- Save and read pending permission
- File locking prevents data loss on concurrent writes
- Handle missing file (returns null/empty)
- Handle expired tokens

#### 2.3 State management tests

**File**: `packages/plugin/test/state.test.ts`

Test cases:

- Initialize session state
- Track running tools (markToolRunning, markToolCompleted)
- Track sent text parts (isTextPartSent, markTextPartSent)
- Mark final response posted
- Mark error posted

#### 2.4 Handler tests

**File**: `packages/plugin/test/handlers.test.ts`

Test the pure/extractable logic from handlers:

- `getToolActionName()` - maps tool names to display actions
- `extractToolParameter()` - extracts relevant parameter for display
- `truncate()` - text truncation with ellipsis
- `mapTodoStatus()` - maps OpenCode todo status to Linear plan status
- `formatToolActivity()` - formats tool part into Linear activity content
- `formatTextResponse()` - formats text part into Linear response content

Note: Full handler integration tests (with Linear client mocks) are lower priority. Focus on pure logic extraction and testing first.

### Phase 3: Remove SSE from Server

**Goal**: Make server stateless (no long-running connections)

#### 3.1 Modify LinearEventProcessor

**File**: `packages/core/src/LinearEventProcessor.ts`

**Remove/modify `executePrompt()`:**

```typescript
private async executePrompt(
  opcodeSessionId: string,
  linearSessionId: string,
  workdir: string,
  prompt: string,
  log: Logger,
  issueId: string,
): Promise<void> {
  // Post sending prompt stage activity
  await this.linear.postStageActivity(linearSessionId, "sending_prompt");

  // Fire-and-forget the prompt
  const result = await this.opencode.prompt(opcodeSessionId, workdir, [
    { type: "text", text: prompt },
  ]);

  if (Result.isError(result)) {
    log.error("Prompt failed", { error: result.error.message });
    await this.linear.postError(linearSessionId, result.error);
  }

  // Return immediately - plugin handles event streaming
  log.info("Prompt sent, plugin will handle events");
}
```

**Remove:**

- `subscribeAndWaitForCompletion()` method
- SSE subscription logic
- `OpencodeEventResult` handling in `executePrompt()`

**Keep:**

- `handleQuestionResponse()` - still reads pending state and replies
- `handlePermissionResponse()` - still reads pending state and replies

#### 3.2 Remove OpencodeEventProcessor

**Files to remove/modify**:

- `packages/core/src/OpencodeEventProcessor.ts` - Remove
- `packages/core/src/index.ts` - Remove export
- `packages/core/test/` - Remove any related tests

The plugin now handles all event streaming to Linear.

### Phase 4: Clean Up Core Package

**Goal**: Remove SSE-related code that's no longer needed

#### 4.1 Remove OpencodeEventProcessor and related code

**Files to delete**:

- `packages/core/src/OpencodeEventProcessor.ts`

**Files to update**:

- `packages/core/src/index.ts` - Remove OpencodeEventProcessor export

#### 4.2 Keep handlers as reference

The handlers in `packages/core/src/handlers/` are well-tested pure functions. Keep them as:

- Reference implementation documenting expected behavior
- Potential future use if we need server-side processing again
- Test coverage for the logic

#### 4.3 Keep OpencodeService.subscribe()

The `subscribe()` method is no longer used by the server but keeping it:

- Doesn't hurt anything
- Could be useful for debugging/testing
- Maintains API completeness

### Phase 5: Integration Testing

**Goal**: Verify end-to-end flow works

#### 5.1 Manual testing checklist

- [ ] Create new Linear issue, delegate to agent
- [ ] Verify agent starts processing (activities appear)
- [ ] Verify plan syncs to Linear
- [ ] Trigger a question (e.g., ask agent to choose between options)
- [ ] Respond to question in Linear
- [ ] Verify agent continues processing
- [ ] Trigger a permission request
- [ ] Approve permission in Linear
- [ ] Verify agent continues processing
- [ ] Verify completion message appears

#### 5.2 Log verification

Verify:

- Server logs show prompt sent
- Server logs show webhook received for responses
- Plugin logs show all events processed
- No duplicate activities posted to Linear

## File Changes Summary

| File                                          | Change                                        |
| --------------------------------------------- | --------------------------------------------- |
| `packages/plugin/src/storage.ts`              | Fix key prefixes                              |
| `packages/plugin/test/parser.test.ts`         | New file                                      |
| `packages/plugin/test/storage.test.ts`        | New file                                      |
| `packages/plugin/test/state.test.ts`          | New file                                      |
| `packages/plugin/test/handlers.test.ts`       | New file                                      |
| `packages/core/src/LinearEventProcessor.ts`   | Remove SSE subscription, make fire-and-forget |
| `packages/core/src/OpencodeEventProcessor.ts` | Delete                                        |
| `packages/core/src/index.ts`                  | Remove OpencodeEventProcessor export          |

## Risks and Mitigations

### Risk: Plugin doesn't save state before user can respond

**Mitigation**: This isn't actually possible. OpenCode blocks waiting for question/permission replies. The user can only respond after seeing the elicitation in Linear, which is posted by the plugin after saving state.

### Risk: Plugin crashes before saving state

**Mitigation**: If plugin crashes, OpenCode session also crashes. Linear will show an error. User can retry by sending a new message.

### Risk: File locking contention

**Mitigation**: Already implemented file locking in Phase 1 of previous work. Lock timeout of 5 seconds with retry.

### Risk: Breaking existing functionality

**Mitigation**:

1. Add plugin tests before making changes
2. Keep SSE logging mode for debugging
3. Test manually with real Linear workspace

## Success Criteria

1. Server webhook handler returns immediately (no blocking on SSE)
2. All Linear activities appear correctly (via plugin)
3. Question/permission flow works end-to-end
4. No duplicate activities posted
5. All tests pass
6. Works in Docker Compose local development environment

## Future Work (Out of Scope)

- Cloudflare KV/D1 storage adapter (for serverless deployment)
- Remove `OpencodeEventProcessor` entirely once plugin is proven stable
- Shared handler utilities package
