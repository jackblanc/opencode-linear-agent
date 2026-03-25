# Target Architecture

This document describes the optimal architecture for a self-hosted Linear agent application powered by OpenCode and built with Effect.

It deliberately ignores the current implementation, current persistence model, and any migration concerns. Treat this as a greenfield design for the product UX this application serves.

## Product Shape

The application exists to do five things well:

- receive Linear webhooks and OAuth callbacks
- maintain durable local state for agent runs and auth
- orchestrate agent work against OpenCode
- reflect progress and decisions back into Linear
- expose a small, reliable local server boundary

This is not a generic workflow engine. It is a focused integration service with a narrow set of external systems and a clear orchestration core.

## Design Principles

- domain-first, not storage-first
- Effect-native dependency injection via `Layer`
- explicit service boundaries for external systems and runtime resources
- plain `Effect` programs for workflows and orchestration
- schema-first data modeling at every boundary
- local durability via `KeyValueStore`
- thin HTTP edge; business logic lives behind it
- no generic repositories or CRUD abstractions

## Top-Level Architecture

```text
                                   +----------------------+
                                   |      Linear UI       |
                                   | comments, mentions,  |
                                   | auth consent, issues |
                                   +----------+-----------+
                                              |
                                              v
                                   +----------------------+
                                   |     HTTP Boundary    |
                                   | oauth, webhook,      |
                                   | health, debug        |
                                   +----------+-----------+
                                              |
                                              v
         +-------------------------------------------------------------------+
         |                           Application Core                         |
         |                                                                   |
         |  oauth workflows  |  webhook intake  |  run orchestration         |
         |  agent event flow |  issue routing   |  Linear sync               |
         +-----------+---------------------+-----------------------+----------+
                     |                     |                       |
                     v                     v                       v
            +----------------+    +----------------+     +----------------+
            |  LinearClient  |    | OpencodeClient |     |    AppState    |
            |   Effect port  |    | generated port |     | domain storage |
            +--------+-------+    +--------+-------+     +--------+-------+
                     |                     |                      |
                     v                     v                      v
             +---------------+      +-------------+      +---------------+
             |  @linear/sdk  |      | OpenAPI API |      | KeyValueStore |
             +---------------+      +-------------+      +---------------+
```

## Bounded Contexts

The system should be split by domain responsibility, not by technical pattern.

### `auth`

Owns:

- Linear OAuth start/callback
- auth token persistence
- token refresh
- webhook signature verification inputs

Core concepts:

- `OAuthState`
- `AuthSession`
- `LinearAccess`

### `runs`

Owns:

- agent run identity
- run lifecycle
- mapping between Linear issue context and OpenCode session context
- worktree/repository routing state

Core concepts:

- `RunId`
- `RunRecord`
- `RunStatus`
- `RepoSelection`

### `questions`

Owns:

- pending user questions
- pending approvals / permission requests
- repo selection requests
- correlating responses back into a run

Core concepts:

- `PendingQuestion`
- `PendingPermission`
- `PendingRepoSelection`

### `linear`

Owns:

- typed interactions with Linear
- issue comments / activities / state changes
- GraphQL queries and mutations
- mapping SDK failures into domain errors

### `opencode`

Owns:

- typed interactions with OpenCode
- session creation / resumption
- non-streaming API calls needed by this app
- translating generated client shapes into app-friendly results

### `http`

Owns:

- route definitions
- request decoding
- auth/webhook middleware
- response encoding
- no orchestration logic beyond boundary concerns

## Effect Service Graph

The runtime graph should be explicit and small.

### Base Services

- `AppConfig`
- `Logger`
- `Clock`
- `Random`
- tracing / spans if enabled

### Infrastructure Services

- `KeyValueStore`
- `AppState`
- `LinearClient`
- `OpencodeClient`
- `WebhookVerifier`

### Application Services

- optional `RunCoordinator` if orchestration becomes large enough to warrant a named service

Everything else should remain plain functions returning `Effect`.

## What Should Be A Service

Make a thing a service when it:

- owns external IO
- owns a runtime resource
- has environment/config-backed construction
- benefits from test substitution as one unit
- represents an integration boundary

Examples:

- `AppConfig`
- `LinearClient`
- `OpencodeClient`
- `AppState`
- `WebhookVerifier`

## What Should Not Be A Service

Do not create services for plain workflows.

These should be plain exported `Effect` functions over the environment:

- `startOAuth`
- `finishOAuth`
- `handleLinearWebhook`
- `processIssueEvent`
- `processAgentEvent`
- `ensureRun`
- `postPendingQuestion`
- `completePermissionRequest`

Reason: these are use-cases, not resources.

## Persistence Model

Use `effect/unstable/persistence/KeyValueStore` as the physical storage engine.

Do not expose it directly to workflows.

Instead, define a single domain persistence service:

- `AppState`

`AppState` is not a generic repository. It is the domain-owned persistence boundary for the application.

It should expose operations named after domain needs, for example:

- `getAuthSession`
- `putAuthSession`
- `deleteOAuthState`
- `getRunByLinearIssue`
- `getRunByOpencodeSession`
- `putRun`
- `getPendingQuestion`
- `putPendingQuestion`
- `deletePendingPermission`

This keeps keys, schemas, indices, and invariants inside one cohesive boundary.

### Key Design Rules

- every persisted record has a `version`
- every persisted record has timestamps
- every keyspace is explicit and prefixed
- reverse indexes are explicit, never implicit
- records are denormalized for app flows
- reads and writes are schema-validated

### Suggested Keyspaces

- `auth/{organizationId}`
- `oauth-state/{state}`
- `run/by-linear-issue/{issueId}`
- `run/by-opencode-session/{sessionId}`
- `pending-question/{runId}`
- `pending-permission/{runId}`
- `pending-repo-selection/{runId}`
- `webhook-dedupe/{eventId}`

If a future requirement demands relational queries or multi-writer coordination, move the physical backend behind `AppState`, not the application model.

## Configuration

Configuration should be file-first, with optional environment overrides.

Best model:

- `Schema` defines `AppConfig`
- startup loads config file
- selected env values may override file values
- final result is decoded once and provided as an `AppConfig` service

This application is a self-hosted local service with structured settings. A typed config document is the natural source of truth.

Use env overrides only where they clearly improve deployment or secret handling.

## HTTP Boundary

The optimal server boundary is an Effect-native HTTP layer.

Recommended approach:

- `HttpRouter` for route composition
- thin middleware for auth, request ids, logging, webhook verification
- handlers decode inputs and call application workflows
- responses are encoded at the edge only

This application does not primarily need a public, reusable API contract. It needs a reliable local integration boundary. That makes `HttpRouter` the best default.

If the public API surface grows substantially, `HttpApi` can become attractive later. It should not shape the core architecture.

### Routes

The boundary should remain small:

- `GET /health`
- `GET /oauth/authorize`
- `GET /oauth/callback`
- `POST /webhooks/linear`
- optional debug/admin endpoints for local operators

## External Clients

### Linear Client

Linear should be wrapped behind a small, Effect-native port.

Implementation:

- build on `@linear/sdk`
- expose only app-relevant operations
- every method returns `Effect`
- map SDK and transport failures into tagged errors

Examples of operations:

- `createAgentActivity`
- `createComment`
- `getIssue`
- `getAgentSession`
- `listIssueLabels`

The app should never depend on raw SDK calls outside the `linear` boundary.

### OpenCode Client

OpenCode should be generated from its OpenAPI schema.

Implementation:

- generate a typed Effect client
- wrap generated details behind a small app-facing module if needed
- no SSE support required for this application if plugin-driven flows cover streaming concerns

Examples of operations:

- `createSession`
- `getSession`
- `sendMessage`
- `listMessages`

## Domain Model

The domain should be modeled explicitly with typed ids, tagged errors, and state records.

### Core Value Types

- `OrganizationId`
- `IssueId`
- `LinearSessionId`
- `OpencodeSessionId`
- `RunId`
- `WebhookEventId`

### Core Records

- `RunRecord`
- `AuthSession`
- `OAuthState`
- `PendingQuestion`
- `PendingPermission`
- `PendingRepoSelection`

### Errors

Use `Schema.TaggedErrorClass` or equivalent tagged error types.

Group errors by boundary:

- `ConfigError`
- `AppStateError`
- `LinearClientError`
- `OpencodeClientError`
- `WebhookVerificationError`
- `RunError`

Do not use stringly-typed error channels.

## Workflow Style

Application logic should be plain `Effect.gen` orchestration over services.

Typical workflow shape:

1. decode external input
2. load required state
3. derive next action from domain rules
4. call external systems
5. persist resulting state
6. emit logs / spans
7. return boundary response

Workflows should be small and composable. Shared logic should be extracted when it is genuinely reusable, not preemptively abstracted.

## Runtime

Use a single application runtime composed from `Layer`s.

Recommended structure:

- `AppConfigLive`
- `KeyValueStoreLive`
- `AppStateLive`
- `LinearClientLive`
- `OpencodeClientLive`
- `WebhookVerifierLive`
- `HttpServerLive`

For integration into Bun, use a managed runtime at the edge and keep runtime ownership centralized.

## Observability

Observability should be built in from day one.

Minimum requirements:

- structured logs
- request id correlation
- run id correlation
- webhook event id correlation
- spans around external API calls
- error tagging by boundary

Important log dimensions:

- `organizationId`
- `issueId`
- `runId`
- `linearSessionId`
- `opencodeSessionId`
- `webhookEventId`

## Testing Strategy

The architecture should optimize for testing by substitution of services, not mocks of internals.

### Domain Tests

- pure tests for state transitions, ids, and error cases

### Service Contract Tests

- `AppState` against an in-memory `KeyValueStore`
- `LinearClient` against test doubles
- `OpencodeClient` against generated client fakes or transport stubs

### Workflow Tests

- test full use-cases with `Layer` substitution
- use `TestClock` where time matters
- verify duplicate webhook handling, retries, and partial failure paths

### HTTP Tests

- route-level tests for auth, webhook verification, and status codes

## Packaging

The cleanest packaging model is two runtime artifacts with one shared core:

- `core`: domain, infra ports, workflows, runtime assembly
- `server`: HTTP entrypoint and hosting glue
- `plugin`: independent OpenCode plugin package

The plugin should remain independent from the server architecture except for agreed protocol and shared schemas where needed.

## Summary

The optimal architecture for this product is:

- Effect-native service graph
- small number of real services
- workflow logic as plain `Effect` programs
- one domain-owned persistence boundary over `KeyValueStore`
- thin Effect HTTP edge
- typed SDK/client boundaries for Linear and OpenCode
- explicit domain model with tagged errors and versioned records

The key design choice is to center the application around domain workflows and integration ports, not generic storage abstractions.
