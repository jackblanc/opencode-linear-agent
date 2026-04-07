# Handler Consolidation Plan

## Problem

The plugin was developed in a separate repo and brought back without integrating with core's existing handlers. This resulted in:

- **~700 lines of dead code** in `packages/core/src/handlers/` (never called)
- **~700 lines of duplicated code** in `packages/plugin/src/handlers.ts`
- **Divergent implementations** with different bugs and features
- **Knip unable to detect unused exports** due to barrel file confusion

### History

1. Original implementation used SSE with `OpencodeEventProcessor` orchestrating core's pure handlers
2. Plugin was built in a separate repo with its own imperative implementation
3. Plugin was merged back, but implementations were never consolidated
4. `OpencodeEventProcessor` was deleted, leaving core's handlers as dead code

### Duplication

| Duplicated Code                        | Core Location                     | Plugin Location             |
| -------------------------------------- | --------------------------------- | --------------------------- |
| `TOOL_ACTION_MAP`                      | `handlers/ToolHandler.ts:9-20`    | `handlers.ts:82-94`         |
| `getToolActionName()`                  | `handlers/ToolHandler.ts:30-41`   | `handlers.ts:124-131`       |
| `extractToolParameter()`               | `handlers/ToolHandler.ts:99-152`  | `handlers.ts:140-193`       |
| `getToolThought()`                     | `handlers/ToolHandler.ts:167-208` | `handlers.ts:195-226`       |
| `toRelativePath()`                     | `handlers/ToolHandler.ts:55-72`   | `handlers.ts:44-60`         |
| `replacePathsInOutput()`               | `handlers/ToolHandler.ts:78-94`   | `handlers.ts:66-80`         |
| `truncateOutput()`                     | `handlers/ToolHandler.ts:157-162` | `handlers.ts:133-138`       |
| `mapTodoStatus()`                      | `handlers/TodoHandler.ts:8-23`    | `handlers.ts:470-483`       |
| `ActivityContent`, `PlanItem`, etc.    | `linear/types.ts`                 | `linear/types.ts`           |
| `LinearService` interface              | `linear/LinearService.ts`         | `linear/client.ts`          |
| Error types                            | `errors/linear.ts` (8 types)      | `linear/errors.ts` (1 type) |
| `PendingQuestion`, `PendingPermission` | `session/SessionRepository.ts`    | `storage.ts`                |
| `HandlerState` / dedup tracking        | `session/SessionState.ts`         | `state.ts`                  |

---

## Goal

Consolidate to a single implementation using core's architecture (pure functions returning actions), while preserving features that only exist in plugin.

### Target Architecture

```
OpenCode Plugin Hook (event)
    │
    ▼
Orchestrator (plugin/src/orchestrator.ts)
    │
    ├── Load session context from file store
    ├── Load/create HandlerState (in-memory)
    │
    ▼
Core Pure Handler (e.g., processToolPart)
    │
    ├── Input: (event, state, context)
    └── Output: { state: newState, actions: Action[] }
    │
    ▼
Execute Actions (executeLinearAction for each action)
    │
    ▼
Persist pending questions/permissions (if any)
```

---

## Audit: Features Plugin Has That Core Lacks

| Feature                           | Location in Plugin                | Notes                                           |
| --------------------------------- | --------------------------------- | ----------------------------------------------- |
| Question tool special handling    | `handleToolPart()` lines 257-274  | Routes `question`/`mcp_question` to elicitation |
| `mcp_question` in TOOL_ACTION_MAP | Line 93                           | Core only has `question`                        |
| Question deduplication            | `markQuestionElicitationPosted()` | Prevents double-posting                         |
| Session error handler             | `handleSessionError()`            | Posts error activities                          |
| Better `toGerund()`               | Lines 100-122                     | Proper English rules                            |

---

## Design Decisions

### 1. Deduplication lives in `HandlerState`

Question deduplication (`postedQuestionElicitations: Set<string>`) will be added to core's `HandlerState`, not kept as plugin-specific orchestrator state. This keeps all handler state in one place.

### 2. Replace `ActionExecutor` class with simple functions

The `ActionExecutor` class requires both `LinearService` and `OpencodeService`, but:

- Plugin only needs `LinearService` (posts elicitations)
- Server handles `OpencodeService` calls (replies to questions/permissions via webhooks)

Replace with two simple functions:

```typescript
// In core
export async function executeLinearAction(
  action: LinearAction,
  linear: LinearService,
): Promise<Result<void, LinearServiceError>>;

export async function executeOpencodeAction(
  action: OpencodeAction,
  opencode: OpencodeService,
): Promise<Result<void, OpencodeServiceError>>;
```

Plugin imports `executeLinearAction`. Server uses both.

### 3. LinearService interface unchanged

Core's `LinearService` already has all methods plugin needs. Plugin will import and use it directly. Methods plugin doesn't need (`moveIssueToInProgress`, etc.) are simply not called.

---

## Phases

Phases are ordered so each can be shipped independently. Phase 1 (Unify LinearService) is a pure refactor with no behavior change - plugin just imports from core instead of its own duplicate.

---

### Phase 1: Unify LinearService ✅ Can ship independently

**1.1 Delete from plugin:**

- `packages/plugin/src/linear/client.ts` (163 lines)
- `packages/plugin/src/linear/errors.ts` (26 lines)

**1.2 Create thin factory in plugin:**

Create `packages/plugin/src/linear.ts`:

```typescript
import { LinearServiceImpl, type LinearService } from "@opencode-linear-agent/core";

export function createLinearService(accessToken: string): LinearService {
  return new LinearServiceImpl(accessToken);
}
```

**1.3 Update plugin imports:**

- Update `plugin.ts` and `handlers.ts` to import `LinearService` type from core
- Update `handlers.ts` to use core's error types for type checking

**1.4 Run tests to verify no behavior change**

---

### Phase 2: Unify Types ✅ Can ship independently

**2.1 Delete from plugin:**

- `packages/plugin/src/linear/types.ts` (76 lines)

**2.2 Update plugin imports to use core:**

- `ActivityContent`, `PlanItem`, `SignalMetadata`, `ElicitationSignal` from core
- `PendingQuestion`, `PendingPermission`, `QuestionInfo`, `QuestionOption` from core

**2.3 Update `packages/plugin/src/storage.ts`**

- Import types from core instead of defining locally

**2.4 Ensure core exports needed types:**

- `QuestionOption` from `session/SessionRepository.ts`
- Any other types plugin needs

---

### Phase 3: Port Missing Features to Core

**3.1 Update `packages/core/src/handlers/ToolHandler.ts`**

- Add `mcp_question` to `TOOL_ACTION_MAP`
- Replace naive `+ "ing"` with proper `toGerund()` from plugin
- Add question tool detection (return early, let `QuestionHandler` handle it)

**3.2 Update `packages/core/src/handlers/QuestionHandler.ts`**

- Handle tool-based questions (from `message.part.updated` with question tool)
- Existing `processQuestionAsked` handles `question.asked` events

**3.3 Create `packages/core/src/handlers/SessionErrorHandler.ts`**

- Port `handleSessionError()` logic from plugin
- Pure function returning `postActivity` action with error type

**3.4 Update `packages/core/src/session/SessionState.ts`**

- Add `postedQuestionElicitations: Set<string>` to `HandlerState`
- Add `postedError: boolean` to `HandlerState`
- Update `createInitialHandlerState()` to initialize new fields

**3.5 Update `packages/core/src/handlers/index.ts`**

- Export new `processSessionError` handler
- Export `processQuestionFromTool` if created separately

---

### Phase 4: Replace ActionExecutor with Functions

**4.1 Create `packages/core/src/actions/execute.ts`**

```typescript
import { Result } from "better-result";
import type { LinearService } from "../linear/LinearService";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { LinearServiceError, OpencodeServiceError } from "../errors";
import type { LinearAction, OpencodeAction } from "./types";

export async function executeLinearAction(
  action: LinearAction,
  linear: LinearService,
): Promise<Result<void, LinearServiceError>> {
  switch (action.type) {
    case "postActivity":
      return linear.postActivity(action.sessionId, action.content, action.ephemeral);
    case "postElicitation":
      return linear.postElicitation(action.sessionId, action.body, action.signal, action.metadata);
    case "updatePlan":
      return linear.updatePlan(action.sessionId, action.plan);
    case "postError":
      return linear.postError(action.sessionId, action.error);
  }
}

export async function executeOpencodeAction(
  action: OpencodeAction,
  opencode: OpencodeService,
): Promise<Result<void, OpencodeServiceError>> {
  switch (action.type) {
    case "replyPermission":
      return opencode.replyPermission(action.requestId, action.reply, action.directory);
    case "replyQuestion":
      return opencode.replyQuestion(action.requestId, action.answers, action.directory);
  }
}

export async function executeLinearActions(
  actions: LinearAction[],
  linear: LinearService,
): Promise<void> {
  for (const action of actions) {
    await executeLinearAction(action, linear);
  }
}
```

**4.2 Delete `packages/core/src/actions/executor.ts`**

**4.3 Update `packages/core/src/actions/index.ts`**

- Remove `ActionExecutor` export
- Add `executeLinearAction`, `executeOpencodeAction`, `executeLinearActions` exports

**4.4 Update `packages/core/src/index.ts`**

- Update exports to reflect changes

---

### Phase 5: Create Orchestrator

Depends on Phases 1-4.

**5.1 Create `packages/plugin/src/orchestrator.ts`**

```typescript
import type { Event } from "@opencode-ai/sdk";
import {
  processToolPart,
  processTextPart,
  processMessageCompleted,
  processTodoUpdated,
  processPermissionAsked,
  processQuestionAsked,
  processSessionError,
  executeLinearActions,
  createInitialHandlerState,
  type HandlerState,
  type LinearService,
  type Action,
} from "@opencode-linear-agent/core";
import { getSessionAsync } from "./storage";
import { savePendingQuestion, savePendingPermission } from "./storage";

// In-memory state per OpenCode session
const handlerStates = new Map<string, HandlerState>();

function getHandlerState(sessionId: string): HandlerState {
  let state = handlerStates.get(sessionId);
  if (!state) {
    state = createInitialHandlerState();
    handlerStates.set(sessionId, state);
  }
  return state;
}

function updateHandlerState(sessionId: string, state: HandlerState): void {
  handlerStates.set(sessionId, state);
}

export async function handleEvent(
  event: Event,
  linear: LinearService,
  log: (msg: string) => void,
): Promise<void> {
  // Extract session ID from event
  const sessionId = extractSessionId(event);
  if (!sessionId) return;

  // Load session context
  const session = await getSessionAsync(sessionId);
  if (!session?.linear.sessionId) return;

  const state = getHandlerState(sessionId);
  const ctx = {
    linearSessionId: session.linear.sessionId,
    opencodeSessionId: sessionId,
    workdir: session.linear.workdir,
    issueId: session.linear.issueId,
  };

  // Route to appropriate handler
  if (event.type === "message.part.updated") {
    const part = event.properties.part;

    if (part.type === "tool") {
      const result = processToolPart(part, state, ctx);
      updateHandlerState(sessionId, result.state);
      await executeLinearActions(result.actions, linear);
    }

    if (part.type === "text") {
      const result = processTextPart(part, state, ctx);
      updateHandlerState(sessionId, result.state);
      await executeLinearActions(result.actions, linear);
    }
  }

  if (event.type === "message.updated") {
    const result = processMessageCompleted(event.properties.info.id, state, ctx);
    updateHandlerState(sessionId, result.state);
    await executeLinearActions(result.actions, linear);
  }

  if (event.type === "todo.updated") {
    const actions = processTodoUpdated(event.properties, ctx);
    await executeLinearActions(actions, linear);
  }

  if (event.type === "session.error") {
    const result = processSessionError(event.properties, state, ctx);
    updateHandlerState(sessionId, result.state);
    await executeLinearActions(result.actions, linear);
  }

  // Handle permission.asked and question.asked similarly...
}

function extractSessionId(event: Event): string | null {
  // Extract from various event property locations
  if ("sessionID" in event.properties) return event.properties.sessionID;
  if ("part" in event.properties) return event.properties.part.sessionID;
  return null;
}
```

---

### Phase 6: Update Plugin Entry Point

**6.1 Modify `packages/plugin/src/plugin.ts`**

```typescript
import { handleEvent } from "./orchestrator";
import { createLinearService } from "./linear";
import { readAccessToken, getSessionAsync } from "./storage";

export const LinearPlugin = definePlugin((api) => {
  const { info } = api.log("LinearPlugin");

  return {
    tool: linearTools,

    event: async ({ event }) => {
      const sessionId = extractSessionId(event);
      if (!sessionId) return;

      const session = await getSessionAsync(sessionId);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);
      await handleEvent(event, linear, info);
    },

    // Keep existing hooks for permissions/questions that need special handling
  };
});
```

---

### Phase 7: Delete Duplicate Code

**7.1 Delete:**

- `packages/plugin/src/handlers.ts` (709 lines)
- `packages/plugin/src/state.ts` (151 lines) - if fully replaced by `HandlerState`

**7.2 Delete tests for deleted code:**

- `packages/plugin/test/handlers.test.ts` - logic now tested in core

---

### Phase 8: Cleanup

**8.1 Update core barrel file `packages/core/src/index.ts`**

- Export only what's actually used
- Remove dead exports

**8.2 Update knip config**

- Remove workarounds, should work correctly now

**8.3 Delete custom script**

- `scripts/check-unused-core-exports.ts` no longer needed

**8.4 Run all tests**

- `bun test` - ensure nothing is broken
- `bun run check` - typecheck, lint, format, knip

---

## File Changes Summary

### Files to Create

| File                                                | Purpose                           |
| --------------------------------------------------- | --------------------------------- |
| `packages/core/src/handlers/SessionErrorHandler.ts` | Handle session.error events       |
| `packages/core/src/actions/execute.ts`              | Simple action execution functions |
| `packages/plugin/src/orchestrator.ts`               | Routes events to core handlers    |
| `packages/plugin/src/linear.ts`                     | Thin factory for LinearService    |

### Files to Delete

| File                                    | Lines | Reason                       |
| --------------------------------------- | ----- | ---------------------------- |
| `packages/plugin/src/handlers.ts`       | 709   | Replaced by core handlers    |
| `packages/plugin/src/state.ts`          | 151   | Replaced by HandlerState     |
| `packages/plugin/src/linear/client.ts`  | 163   | Use core's LinearService     |
| `packages/plugin/src/linear/errors.ts`  | 26    | Use core's errors            |
| `packages/plugin/src/linear/types.ts`   | 76    | Use core's types             |
| `packages/core/src/actions/executor.ts` | 118   | Replaced by simple functions |
| `scripts/check-unused-core-exports.ts`  | 130   | No longer needed             |
| `packages/plugin/test/handlers.test.ts` | ~300  | Logic tested in core         |

**Total deleted: ~1,673 lines**

### Files to Modify

| File                                            | Changes                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| `packages/core/src/handlers/ToolHandler.ts`     | Add mcp_question, toGerund, question detection |
| `packages/core/src/handlers/QuestionHandler.ts` | Handle tool-based questions                    |
| `packages/core/src/session/SessionState.ts`     | Add dedup fields to HandlerState               |
| `packages/core/src/handlers/index.ts`           | Export new handlers                            |
| `packages/core/src/actions/index.ts`            | Export execute functions                       |
| `packages/core/src/index.ts`                    | Update exports                                 |
| `packages/plugin/src/plugin.ts`                 | Use orchestrator                               |
| `packages/plugin/src/storage.ts`                | Import types from core                         |
| `knip.jsonc`                                    | Remove workarounds                             |

### Net Result

- **~1,673 lines deleted**
- **~250 lines added** (orchestrator, execute functions, SessionErrorHandler)
- **Net reduction: ~1,400 lines**
- Single source of truth for handler logic
- Plugin becomes thin integration layer
- Core's tested handlers are actually used

---

## Testing Strategy

1. **Unit tests for core handlers** - Already exist in `packages/core/test/handlers/`
2. **Add tests for new handlers** - `SessionErrorHandler`, updated `QuestionHandler`
3. **Integration tests for orchestrator** - Verify events flow through correctly
4. **Manual testing** - Run full flow with Linear

---

## Risks & Mitigation

| Risk                                                | Mitigation                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Subtle behavior differences between implementations | Careful audit (done above), keep plugin tests until confident              |
| State management migration issues                   | Core's `HandlerState` is well-defined, orchestrator just passes it through |
| Breaking existing functionality                     | Run all tests after each phase, manual testing before merge                |

---

## Estimated Effort

| Phase                           | Time         | Can Ship Independently? |
| ------------------------------- | ------------ | ----------------------- |
| Phase 1: Unify LinearService    | 15 min       | ✅ Yes                  |
| Phase 2: Unify types            | 15 min       | ✅ Yes                  |
| Phase 3: Port features to core  | 45 min       | ✅ Yes                  |
| Phase 4: Replace ActionExecutor | 20 min       | ✅ Yes                  |
| Phase 5: Create orchestrator    | 45 min       | No (needs 1-4)          |
| Phase 6: Update plugin entry    | 20 min       | No (needs 5)            |
| Phase 7: Delete duplicate code  | 10 min       | No (needs 6)            |
| Phase 8: Cleanup                | 20 min       | No (needs 7)            |
| **Total**                       | **~3 hours** |                         |
