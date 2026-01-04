# Webhook Timeout Investigation

**Date**: January 3, 2026

## Problem Statement

Linear webhooks are failing with the following symptoms:

1. Linear webhook is received
2. Worker starts and initializes container in `ctx.waitUntil()`
3. `waitUntil` times out with: `IoContext timed out due to inactivity`
4. Prompt is never sent to OpenCode server
5. Linear gets stuck showing "Installing dependencies..."

## Key Finding from Logs

The timeout occurs **8 seconds** into processing, not 30 seconds:

```
10:13:59 PM - Webhook received
10:14:01 PM - mkdir /workspace/repo (131ms)
10:14:05 PM - git clone (3065ms) ✓
10:14:06 PM - mkdir /workspace/sessions (892ms)
10:14:07 PM - git worktree add (230ms)
10:14:07 PM - git config (122ms)
10:14:07 PM - git remote set-url (104ms)
10:14:07 PM - bun install started...
10:14:07 PM - Sandbox.exec - CANCELED
10:14:07 PM - IoContext timed out due to inactivity
```

The `bun install` command was started but immediately canceled. The command itself wasn't failing — the Worker's I/O context was terminated while waiting for the sandbox to respond.

## Root Cause Analysis

### What `waitUntil` Actually Does

From Cloudflare docs:

> When the client disconnects, all tasks associated with that client's request are proactively canceled. If the Worker passed a promise to `event.waitUntil()`, cancellation will be delayed until the promise has completed **or until an additional 30 seconds have elapsed**, whichever happens first.

The 30-second grace period starts when the client (Linear) disconnects after receiving the `200 OK` response.

### The "Inactivity" Mystery

The error says "IoContext timed out due to **inactivity**" — not just "timed out". This suggests Cloudflare has a separate, shorter inactivity timeout for `waitUntil` tasks. If the Worker is waiting on a single long I/O operation (like `sandbox.exec()`) without other activity, Cloudflare may consider it "inactive" and kill it.

This is not well-documented and may be an internal Cloudflare mechanism.

## Current Architecture Issues

### Shared Sandbox Complexity

The current design uses a single shared Sandbox DO (`opencode-instance`) with:

- A primary repo at `/workspace/repo`
- Session-specific worktrees at `/workspace/sessions/{sessionId}`
- Complex initialization logic to manage shared vs session-specific state

This creates:

- Race conditions between UI access and webhook processing
- Complex state management in KV
- Multiple code paths for "ensure X is ready"

### Heavy Work in Webhook Flow

The webhook handler does significant work in `ctx.waitUntil()`:

1. Clone primary repo (if not exists)
2. Create git worktree for session
3. Configure git user/remote
4. Run `bun install`
5. Initialize OpenCode server
6. Create OpenCode session
7. Send prompt

Even though individual operations are fast (clone ~3s, worktree ~1s), the chain can exceed the inactivity timeout.

## Proposed Simplification: One Sandbox Per Linear Session

Instead of a shared sandbox with worktrees, use a separate Sandbox DO for each Linear session:

```typescript
// Instead of:
const sandbox = getSandbox(env.Sandbox, "opencode-instance");

// Do:
const sandbox = getSandbox(env.Sandbox, `linear-${linearSessionId}`);
```

### Benefits

1. **Complete isolation** — No shared state between sessions
2. **Simpler code** — No worktree management, no "ensure primary repo exists"
3. **Natural persistence** — Sandbox DO persists, so follow-up prompts (`prompted` action) reuse the same warm container with deps already installed
4. **Cleaner resource model** — Each session has its own container lifecycle

### Flow: New Session (`created`)

1. Webhook received
2. Get sandbox by Linear session ID
3. Clone repo, install deps (first time only)
4. Start OpenCode server, send prompt
5. Return 200 OK

### Flow: Follow-up (`prompted`)

1. Webhook received
2. Get sandbox by Linear session ID (same DO, already warm)
3. Send prompt (repo + deps already there)
4. Return 200 OK

## Open Questions

### Does This Solve the Timeout?

Not inherently — we'd still be doing work in `waitUntil`. But simpler code may help identify the real issue.

### Alternative: Fully Decouple with Queue

If the timeout persists, we could:

1. Webhook validates, sends Linear acknowledgment, stores pending prompt in KV
2. Queue message for async processing
3. Queue consumer (15-min limit) does heavy work
4. Return 200 OK immediately

This adds infrastructure but guarantees the work completes.

### Alternative: Sandbox Self-Initialization

1. Webhook stores pending prompt in KV
2. Calls `sandbox.start()` to wake the DO
3. Returns 200 OK
4. Sandbox DO (via alarm or startup hook) checks KV for pending prompts

This decouples the webhook response from actual processing.

## UI Considerations

With per-session sandboxes:

- The `externalLink` on Linear sessions would point to that session's sandbox
- May need a separate "admin" sandbox for general UI access, or remove the general UI entirely
- Each session's OpenCode UI would show only that session's context

## Next Steps

1. **Simplify first**: Implement one-sandbox-per-session to reduce complexity
2. **Test**: See if the timeout still occurs with simpler code
3. **Decouple if needed**: Add Queue-based processing if timeout persists
4. **Remove worktree code**: Replace with simple full clone per sandbox

## Reference: Cloudflare Sandbox Example Pattern

The official Cloudflare Sandbox + OpenCode example does NOT use `waitUntil` for heavy work. Instead, it does work in the request path (blocking) because the client stays connected:

```typescript
// Example pattern (client stays connected)
await sandbox.gitCheckout(...);
const { client } = await createOpencode(...);
await client.session.prompt(...);  // Blocking, not promptAsync
return new Response(...);
```

We can't use this pattern directly because Linear requires response within 5 seconds.
