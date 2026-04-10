# App Core Architecture

## Purpose

`app-core` is a fresh implementation of the Linear agent application.

It owns:

1. domain model
2. durable state
3. workflows
4. external client integration
5. runtime assembly for server and plugin processes

It does not own:

1. HTTP framework details
2. OpenCode plugin host glue
3. CLI packaging or binary distribution

Those stay at the process edge.

## Primary Goals

1. Effect-native architecture end to end
2. typed failures in the error channel
3. durable, queryable local state
4. explicit workflows and invariants
5. no legacy compatibility layer

## Core Decisions

### Effect

All application logic is expressed as `Effect.Effect<A, E, R>`.

Rules:

1. no `Promise` in internal service APIs
2. no `Result` return types
3. no class-based services or repositories
4. no ad hoc global state

Use:

1. `Effect.gen` for workflow composition
2. `Context.Service` for service definitions
3. `Layer` for assembly
4. `Scope` and `Effect.acquireRelease` for lifecycle
5. Effect logger for all logs

### Storage

Use SQLite for durable local state.

Why:

1. transactional updates
2. natural indexing
3. simpler concurrency than file locks
4. inspectable with standard SQLite tooling
5. easier schema evolution than bespoke KV files

### ORM / Query Layer

Use SQLite with Drizzle, wrapped behind Effect services.

Rationale:

1. Drizzle is practical and proven for Bun + SQLite
2. schema and migrations are explicit
3. query code stays local and understandable
4. Effect's runtime, services, errors, and logging are still the application model

This package should not expose raw Drizzle to higher layers.

The storage boundary is:

1. Effect services internally using Drizzle
2. domain-facing repository APIs returning `Effect`

## External Systems

`app-core` integrates with:

1. Linear webhook delivery
2. Linear SDK / API
3. OpenCode SDK / server
4. OpenCode plugin event stream
5. local filesystem
6. local git repositories and worktrees
7. SQLite database

## Process Model

There are two process contexts.

### Server Process

Responsibilities:

1. receive Linear webhooks
2. verify webhook authenticity
3. perform OAuth flows if needed
4. dispatch workflows into `app-core`
5. expose health and operational endpoints if needed

The server process is a thin transport shell over `app-core`.

### Plugin Process

Responsibilities:

1. receive OpenCode plugin events
2. dispatch plugin workflows into `app-core`
3. forward Effect logs to the host process output

The plugin process is also a thin shell over `app-core`.

## Domain Model

All domain objects are plain data, not classes.

Core identifiers:

1. `OrganizationId`
2. `IssueId`
3. `LinearAgentSessionId`
4. `OpenCodeSessionId`
5. `CommentId`
6. `RepoId`
7. `WorktreeId`

Core entities:

1. `Config`
2. `IssueRef`
3. `RepoCandidate`
4. `RepoSelection`
5. `SessionState`
6. `PendingQuestion`
7. `PendingPermission`
8. `PendingRepoSelection`
9. `WebhookEvent`
10. `PluginEvent`

## Durable State

Persist only state required for correctness, recovery, and idempotency.

Minimum durable data:

1. session record keyed by Linear agent session id
2. reverse mapping from OpenCode session id to Linear session
3. current issue/session mode
4. pending question state
5. pending permission state
6. pending repo selection state
7. OAuth token state if OAuth remains in scope
8. idempotency markers for webhook/plugin replay safety where needed

The database schema should optimize for:

1. lookup by Linear session id
2. lookup by OpenCode session id
3. lookup by issue id
4. listing unresolved pending interactions
5. atomic state transitions

## Service Boundaries

Services are defined with `Context.Service` and implemented with `Layer`.

Core services:

1. `AppConfig`
2. `AppClock`
3. `AppLogger`
4. `Database`
5. `AuthStore`
6. `SessionStore`
7. `LinearClient`
8. `OpenCodeClient`
9. `WebhookVerifier`
10. `RepoLocator`
11. `WorktreeManager`
12. `IssueWorkflow`
13. `AgentSessionWorkflow`
14. `PluginWorkflow`

Notes:

1. `AppLogger` may be omitted if direct Effect logging is sufficient
2. storage services should expose domain operations, not table details
3. external SDKs are wrapped once at the boundary

## Error Model

Use `Data.TaggedError` by default.

Error groups:

1. `ConfigError`
2. `DatabaseError`
3. `AuthError`
4. `LinearError`
5. `OpenCodeError`
6. `WebhookError`
7. `RepoError`
8. `WorktreeError`
9. `WorkflowError`

Rules:

1. expected failures stay in the error channel
2. defects are reserved for truly impossible or corrupted states
3. workflow errors should preserve lower-level cause context
4. HTTP and plugin edges map typed errors to transport behavior

Use schema-backed error classes only if an error itself must be encoded across a boundary.

## Logging

Use Effect logger only.

Guidelines:

1. annotate logs with issue id, organization id, Linear session id, and OpenCode session id when available
2. add spans around top-level workflows
3. keep logs structured and machine-readable in non-interactive environments
4. do not introduce a custom logging abstraction unless it adds real domain value

## Workflows

Top-level workflows:

### Issue Workflow

Triggered by Linear issue events.

Responsibilities:

1. inspect issue state relevant to agent dispatch
2. decide whether work should start, be ignored, or be updated
3. initialize or update durable workflow state
4. create or coordinate an OpenCode session when needed

### Agent Session Workflow

Triggered by Linear agent session events.

Responsibilities:

1. verify session relevance
2. resolve auth and issue context
3. select or confirm repository/worktree context
4. start or continue OpenCode interaction
5. persist session linkage and pending interaction state

### Plugin Workflow

Triggered by OpenCode plugin events.

Responsibilities:

1. resolve session linkage
2. translate OpenCode events into Linear-facing side effects
3. update durable state
4. handle questions, permissions, todos, and completion

## Invariants

These must always hold.

1. a persisted OpenCode session id maps to exactly one active Linear agent session
2. pending question state is associated with exactly one session
3. pending permission state is associated with exactly one session
4. pending repo selection state is associated with exactly one session
5. session transitions are atomic
6. workflows are safe to retry after process restart
7. webhook verification happens before any trusted side effect

## Persistence Strategy

Schema layout should be explicit and migration-backed.

Suggested table groups:

1. `auth_*`
2. `session_*`
3. `pending_*`
4. `event_*` if replay or dedupe state is needed

Migrations should be append-only and generated from schema definitions.

## HTTP / Plugin Edges

The transport edge should stay thin.

Server edge responsibilities:

1. parse request
2. verify required headers and raw payload availability
3. invoke `app-core` workflow
4. map typed error to HTTP response

Plugin edge responsibilities:

1. receive host callback
2. normalize incoming event shape
3. invoke `app-core` workflow
4. map typed error to host logging/reporting behavior

No transport edge should contain business logic.

## Package Layout

Suggested layout:

```text
packages/app-core/
  src/
    domain/
    error/
    config/
    db/
    auth/
    session/
    linear/
    opencode/
    repo/
    workflow/
    runtime/
    index.ts
```

Guidelines:

1. `domain/` contains data shapes and identifiers
2. `error/` contains tagged errors
3. `db/` owns Drizzle schema, migrations, and DB layer
4. `workflow/` owns top-level use cases
5. `runtime/` owns layer composition for server and plugin

## Testing Strategy

Use Effect-native tests.

Test layers:

1. in-memory or temporary SQLite database layer
2. fake Linear client
3. fake OpenCode client
4. fake filesystem or temp directory layer
5. deterministic clock where needed

Test categories:

1. domain tests
2. repository tests
3. workflow tests
4. edge integration tests

## Non-Goals

These are explicitly not goals of `app-core`.

1. preserving old internal APIs
2. preserving old persistence format
3. keeping class-based design
4. keeping custom logging primitives
5. mirroring old package structure for its own sake

## Initial Implementation Order

1. define domain identifiers and tagged errors
2. define configuration model
3. implement SQLite/Drizzle database layer
4. implement auth and session stores
5. implement Linear and OpenCode clients
6. implement workflows
7. wire server and plugin edges to the new package
