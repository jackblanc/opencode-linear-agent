# State Storage Refactor Plan

## Goal

Replace the current shared `store.json` model with a namespaced file-per-key state system owned by `packages/core`.

This is a breaking change. We do not optimize for migration compatibility. We optimize for a clean data model, clear ownership, and low-conflict concurrent access.

## Why

Current problems:

- state ownership is split across `core`, `server`, and `plugin`
- `server` and `plugin` both know storage key conventions
- plugin storage access is now routed through `packages/core`, but the exposed helpers still encode legacy shared-store assumptions
- a single `store.json` file creates avoidable write conflicts and whole-file corruption risk
- current lookups still depend on full shared-store scans and "first token wins" behavior

Recent prep already landed:

- storage impl ownership moved from `packages/server` to `packages/core`
- plugin session resolution now starts from `opencodeSessionId`, not `workdir`
- plugin-local storage module has been removed in favor of core-owned helpers
- shared-store writes now use core-owned file locking

That prep is directionally good, but it is not a substitute for the new storage model. We should avoid doing more foundational work on the legacy `store.json` path beyond what is required to safely migrate off it.

Current legacy bridge still in place:

- `packages/core/src/storage/plugin.ts` is now the only plugin-facing storage bridge
- it still scans legacy shared-store session records internally
- it still infers `organizationId` via legacy token scan because session records do not yet store org identity

This means plugin ownership is fixed, but the legacy data model is still the current blocker.

Desired properties:

- one persistence implementation owner: `packages/core`
- one file per key
- one namespace per state domain
- no `workdir`-based lookup
- no raw storage access outside core
- explicit indexes for the lookups we actually need

## High-Level Design

### Ownership

- `packages/core` owns all persisted state types, codecs, file layout, indexes, and storage APIs
- `packages/server` only wires core stores into runtime flows
- `packages/plugin` only uses core storage APIs

### New Storage Shape

State root:

```text
$XDG_DATA_HOME/opencode-linear-agent/state/
```

Namespaces:

```text
auth/
oauth-state/
session/
session-by-opencode/
question/
permission/
repo-selection/
```

Examples:

```text
state/session/<linearSessionId>.json
state/session-by-opencode/<opencodeSessionId>.json
state/auth/<organizationId>.json
state/question/<linearSessionId>.json
state/permission/<linearSessionId>.json
state/repo-selection/<linearSessionId>.json
state/oauth-state/<stateId>.json
```

## Data Model

### Canonical Keys

- session primary key: `linearSessionId`
- plugin session lookup key: `opencodeSessionId`
- auth lookup key: `organizationId`
- pending question key: `linearSessionId`
- pending permission key: `linearSessionId`
- pending repo-selection key: `linearSessionId`
- OAuth CSRF key: `state`

### Records

#### SessionRecord

Primary record at `session/<linearSessionId>.json`.

Fields:

- `linearSessionId`
- `opencodeSessionId`
- `organizationId`
- `issueId`
- `repoDirectory?`
- `branchName`
- `workdir`
- `lastActivityTime`

Notes:

- `organizationId` must be stored on the session so plugin can resolve auth without scanning tokens
- `workdir` remains payload only, not a lookup key

#### SessionByOpencodeRecord

Index record at `session-by-opencode/<opencodeSessionId>.json`.

Fields:

- `linearSessionId`

Notes:

- index stores pointer data only
- canonical session data lives only in `session/`

#### AuthRecord

Primary record at `auth/<organizationId>.json`.

Fields:

- `organizationId`
- `accessToken`
- `accessTokenExpiresAt`
- `refreshToken`
- `appId`
- `installedAt`
- `workspaceName?`

Notes:

- keep one auth record per org
- stop splitting access and refresh token state across separate logical keys
- access token expiry is first-class data, not implicit KV TTL metadata

#### PendingQuestionRecord

Primary record at `question/<linearSessionId>.json`.

Fields:

- `requestId`
- `opencodeSessionId`
- `linearSessionId`
- `workdir`
- `issueId`
- `questions`
- `answers`
- `createdAt`

#### PendingPermissionRecord

Primary record at `permission/<linearSessionId>.json`.

Fields:

- `requestId`
- `opencodeSessionId`
- `linearSessionId`
- `workdir`
- `issueId`
- `permission`
- `patterns`
- `metadata`
- `createdAt`

#### PendingRepoSelectionRecord

Primary record at `repo-selection/<linearSessionId>.json`.

Fields:

- `linearSessionId`
- `issueId`
- `options`
- `promptContext?`
- `createdAt`

#### OAuthStateRecord

Primary record at `oauth-state/<stateId>.json`.

Fields:

- `state`
- `createdAt`
- `expiresAt`

Notes:

- TTL lives in this record, not in generic KV metadata
- consume-once semantics belong to this store

## Required Entry Points

These drive the model.

### Plugin

Plugin event handling starts with `opencodeSessionId`.

Required reads:

1. `session-by-opencode/<opencodeSessionId>` -> `linearSessionId`
2. `session/<linearSessionId>` -> session context
3. `auth/<organizationId>` -> access token

Plugin writes:

- `question/<linearSessionId>`
- `permission/<linearSessionId>`

Important:

- plugin should not do file scans, path construction, or token fallback logic
- plugin should only call core storage APIs

### Server

Server flows start with either `linearSessionId`, `organizationId`, or OAuth `state`.

Required reads/writes:

- `auth/<organizationId>` for access token + refresh token flows
- `session/<linearSessionId>` for session lifecycle
- `question/<linearSessionId>` for question reply handling
- `permission/<linearSessionId>` for permission reply handling
- `repo-selection/<linearSessionId>` for repo routing prompt handling
- `oauth-state/<state>` for CSRF validation

### Explicitly Not Needed

We should not build first-class lookup paths for:

- `workdir`
- `issueId`
- `requestId`

until a real caller requires them.

## Module Structure

### KV Foundation

```text
packages/core/src/kv/
  errors.ts
  key.ts
  json.ts
  types.ts
  index.ts
  file/
    atomic.ts
    lock.ts
    FileNamespaceStore.ts
    FileStateRoot.ts
```

Responsibilities:

- key -> safe filename encoding
- JSON parse/stringify helpers
- atomic write via temp file + rename
- per-file write locking
- namespace root wiring
- typed low-level read/write/delete primitives

### State Layer

```text
packages/core/src/state/
  index.ts
  root.ts
  auth/
    schema.ts
    types.ts
    store.ts
    index.ts
  oauth-state/
    schema.ts
    types.ts
    store.ts
    index.ts
  session/
    schema.ts
    types.ts
    store.ts
    index.ts
  question/
    schema.ts
    types.ts
    store.ts
    index.ts
  permission/
    schema.ts
    types.ts
    store.ts
    index.ts
  repo-selection/
    schema.ts
    types.ts
    store.ts
    index.ts
```

Responsibilities:

- domain record schemas
- typed store APIs per namespace
- index maintenance where needed
- store-specific semantics like OAuth state expiry/consume

## API Design

### Low-Level KV

Low-level KV should be generic and typed, but narrow.

Recommended surface:

- `get(key)`
- `put(key, value)`
- `delete(key)`
- optionally `has(key)` if it materially simplifies callers

Recommended behavior:

- low-level KV returns `Result`
- high-level state stores map not-found to `null` where appropriate

### High-Level State Stores

#### AuthStore

- `get(organizationId)`
- `put(record)`
- `delete(organizationId)`
- `getAccessToken(organizationId)`
- `updateAccessToken(organizationId, accessToken, accessTokenExpiresAt)`

#### OAuthStateStore

- `issue(stateId, now, expiresAt)` or `put(record)`
- `consume(stateId)`

`consume` should validate expiry and delete on success.

#### SessionStore

- `get(linearSessionId)`
- `put(record)`
- `delete(linearSessionId)`
- `touch(linearSessionId, time?)`
- `getByOpencodeSessionId(opencodeSessionId)`

`put` and `delete` must maintain the `session-by-opencode` index under one shared session-operation lock.

`getByOpencodeSessionId` should:

- read `session-by-opencode/<opencodeSessionId>`
- read canonical `session/<linearSessionId>`
- if the canonical session is missing, return `null` and best-effort delete the stale index record

#### PendingQuestionStore

- `get(linearSessionId)`
- `put(record)`
- `delete(linearSessionId)`

#### PendingPermissionStore

- `get(linearSessionId)`
- `put(record)`
- `delete(linearSessionId)`

#### PendingRepoSelectionStore

- `get(linearSessionId)`
- `put(record)`
- `delete(linearSessionId)`

### Root Factory

Expose one entry point for runtime wiring.

Example:

```ts
const state = createFileAgentState(getStateRootPath());
```

`getStateRootPath()` should resolve:

```text
$XDG_DATA_HOME/opencode-linear-agent/state/
```

Returned object should include:

- `state.auth`
- `state.oauthState`
- `state.session`
- `state.question`
- `state.permission`
- `state.repoSelection`

## Files and Types to Move or Delete

### Move Into `state/*`

- persisted `SessionState` from `packages/core/src/session/SessionState.ts`
- pending question types from `packages/core/src/session/SessionRepository.ts`
- pending permission types from `packages/core/src/session/SessionRepository.ts`
- pending repo selection types from `packages/core/src/session/SessionRepository.ts`

### Keep Where They Are

- transient `HandlerState` in `packages/core/src/session/SessionState.ts`

### Delete

- `packages/plugin/src/storage.ts`
- old shared-store blob schema and helpers tied to `store.json`, including `packages/core/src/storage/FileStore.ts`, `packages/core/src/storage/FileTokenStore.ts`, `packages/core/src/session/FileSessionRepository.ts`, `packages/core/src/storage/plugin.ts`, `packages/core/src/schemas.ts`, and `getStorePath()`-based runtime wiring
- old generic storage exports once all callers are migrated

## Implementation Phases

### Phase 1 - KV Foundation

Deliverables:

- safe key encoding
- JSON parse/validate helpers
- atomic file write helper
- per-file write lock helper
- multi-file operation lock helper for index-maintaining writes
- file namespace store
- state root factory for namespace paths
- tests for all of the above

Explicit non-goals:

- do not harden legacy `store.json` locking as an alternative foundation
- do not add new lookup paths or new callers on top of the shared blob store unless needed for migration safety

Key encoding requirements:

- no path separators in emitted filenames
- no `.` / `..` path semantics
- deterministic roundtrip between logical key and filename
- no collisions between distinct logical keys

Done when:

- no state-domain logic is required to read/write one namespaced record safely

### Phase 2 - Session Store and Index

Deliverables:

- `SessionRecord`
- `SessionStore`
- `session-by-opencode` index
- `organizationId` added to canonical session data
- core plugin-facing session resolution wired to new session store

Behavior:

- session writes and deletes hold one shared lock that covers canonical record + index update
- session delete also deletes `question/<linearSessionId>`, `permission/<linearSessionId>`, and `repo-selection/<linearSessionId>`

Why next:

- plugin already enters through `opencodeSessionId`
- current biggest correctness gap is missing `organizationId` on session state
- this removes the last justification for legacy session/token scan logic

### Phase 3 - Auth and OAuth State

Deliverables:

- `AuthStore`
- `OAuthStateStore`
- auth lookup wired from `session.organizationId`
- server OAuth handlers wired to new stores

Behavior:

- OAuth callback writes a single `auth/<organizationId>` record
- access token refresh updates both token value and expiry on that record
- OAuth state expiry lives in the record and `consume` owns validation + delete

Why after session:

- auth lookup key is already clean, but session is the missing join record
- once session carries `organizationId`, auth migration becomes straightforward and correct

### Phase 4 - Pending Interaction Stores

Deliverables:

- `PendingQuestionStore`
- `PendingPermissionStore`
- `PendingRepoSelectionStore`
- server reply handling wired to new stores

### Phase 5 - Server and Plugin Cutover

Deliverables:

- server session/auth/pending flows use new stores
- plugin bridge in `packages/core/src/storage/plugin.ts` swaps from legacy `store.json` internals to new state stores
- plugin event resolution starts from `opencodeSessionId`, not `workdir`
- plugin orchestrator storage lookup path changes to `session-by-opencode/<opencodeSessionId>` -> `session/<linearSessionId>` -> `auth/<organizationId>`
- plugin reads auth via `organizationId` from session
- plugin writes pending question/permission via core stores
- no plugin-side raw file reads or lock logic remain

Status:

- plugin ownership is already fixed as prep work
- remaining bullets still require the new state model and should not be simulated with more `store.json` helpers

### Phase 6 - Cleanup

Deliverables:

- delete remaining legacy shared-store impls in `packages/core`
- delete any temporary migration helpers that expose `store.json` access through core
- remove `store.json` pathing and schema helpers
- update docs and tests

## Concurrency and Correctness Rules

- one file per key
- writes use temp file + rename
- writes use per-file lock
- multi-file updates that must stay consistent use one higher-level operation lock
- reads validate per-record JSON against zod schema
- one corrupt file must not brick unrelated state
- indexes store pointer data only
- no raw path construction outside KV layer
- stale indexes fail narrow: return `null`, then best-effort cleanup

## Testing Plan

### KV Tests

- put/get roundtrip
- delete
- missing key
- invalid JSON
- invalid schema
- key encoding roundtrip
- atomic overwrite
- concurrent writes same key do not corrupt file
- different namespaces do not collide

### Auth/OAuth Tests

- auth record roundtrip
- update access token only
- consume valid OAuth state
- reject expired OAuth state
- reject missing OAuth state

### Session Tests

- put/get session
- get by OpenCode session ID
- updating a session updates the index
- deleting a session deletes the index
- stale index handling if canonical session is missing

### Interaction Store Tests

- question roundtrip
- permission roundtrip
- repo selection roundtrip
- delete semantics

### Integration Tests

- OAuth callback stores auth in new layout
- session creation stores session + index
- plugin event resolves context by `opencodeSessionId`
- plugin question/permission flows persist records into new namespaces

## Risks

- bad key encoding can create path traversal or collisions
- missing operation-level locking on index updates can leave dangling session indexes
- plugin/server dual writes can still race if write locking is incomplete
- stale indexes can mask session deletion bugs
- partially written or corrupt files must fail narrowly, not globally
- over-preserving old abstractions can leak old design into the new model
- spending more effort on `store.json` concurrency can delay migration while still leaving whole-file contention in place

## Design Rules

- no `workdir`-based lookup
- no full-directory scan for normal reads
- no raw file access outside `packages/core`
- no duplicated key naming conventions outside core
- no duplicate canonical session data in indexes
- storage should reflect actual lookup needs, not legacy layout

## Immediate Next Steps

1. finish KV foundation under `packages/core/src/kv/`
2. add `getStateRootPath()` and stop extending `getStorePath()`
3. define `SessionRecord` with `organizationId`
4. build `session-by-opencode` index and session store
5. swap core plugin-facing session resolution off legacy shared-store scans
6. define schemas/types for `auth` and `oauth-state`
7. wire auth lookup from `session.organizationId`

## Current Baseline

Done:

- storage impls live in `packages/core`
- plugin no longer has its own storage implementation
- plugin resolves sessions by `opencodeSessionId`
- repo checks pass from this baseline

Still temporary:

- legacy `store.json`
- legacy shared-store schema in `packages/core/src/schemas.ts`
- token lookup by fallback scan in `packages/core/src/storage/plugin.ts`
- legacy session scan in `packages/core/src/storage/plugin.ts`

## Current Status Snapshot

- prep done: plugin storage helpers moved under `packages/core`
- prep done: plugin resolves session entry from `opencodeSessionId`
- not done: file-per-key KV foundation
- not done: state root at `$XDG_DATA_HOME/opencode-linear-agent/state/`
- not done: `AuthStore`, `OAuthStateStore`, `SessionStore`, interaction stores
- not done: canonical session record with `organizationId`
- not done: `session-by-opencode` index
- not done: removal of legacy `store.json` runtime wiring

## Unresolved Questions

- `Result` low-level, `null` high-level?
- exact operation-lock scope for session + index writes?
- `opencodeSessionId` immutable after session create?
