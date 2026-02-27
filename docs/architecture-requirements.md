# Architecture Requirements

> **Note:** Historical planning doc. Decisions here predate current Bun + tunnel setup.

## Goal

Achieve **parity** between the local TUI development experience and the remote experience (Linear agent, web UI, mobile access).

---

## Current Local Experience (TUI)

1. Run `opencode` in a terminal
2. Server starts automatically, detects project from current working directory
3. Sessions run against that project's files
4. Auth via Claude Max OAuth (stored in `~/.local/share/opencode`)
5. MCP servers (Linear, Context7, etc.) available
6. Full tool access: read, write, edit, bash, etc.

---

## Desired Remote Experience

The remote experience (Linear agent, web UI, mobile) should work identically to local:

1. **Linear webhook** or **web UI request** triggers a session
2. Agent determines which repo to work on (via `repo:*` label, GitHub link, or explicit selection)
3. Session runs against that repo's files with full tool access
4. Same auth and config as local
5. Same MCP servers available
6. Real-time progress streamed back to Linear / web UI

---

## Pain Points with Current Docker Approach

- Container rebuilds required on code changes
- Auth expiration requires restarting containers
- Complex volume mounts to share host auth/config
- Docker adds overhead and indirection
- Debugging is harder inside containers

---

## Key Constraints

### Project Selection

- **Local**: Terminal's cwd determines the project
- **Remote**: Linear issue or web UI determines the project (via `repo:*` label, GitHub link, or explicit selection)

### Availability

- **Local**: Only available when machine is awake and running
- **Remote**: Should be always-available for Linear webhooks

### Access Patterns

- **TUI**: Used for local interactive development (no remote access needed)
- **Web UI / Mobile**: Remote access to start sessions, view progress
- **Linear**: Webhook-driven, needs reliable endpoint

---

## Open Questions

1. **Number of repos**: How many repos will the Linear agent actively work on?
   - Few (2-3): Could run persistent server per project
   - Many: Need dynamic project selection

2. **Execution environment**: Where should remote sessions run?
   - Cloudflare Sandbox (managed, isolated containers)
   - Self-hosted VPS / home server
   - Hybrid (local when awake, cloud fallback)

3. **Cold start latency**: Acceptable delay for Linear delegation?
   - Instant (~0s): Pre-warmed server per project
   - Fast (~5-10s): Spin up server on demand
   - Acceptable (~30s+): Full container boot

4. **Web/Mobile UI**: Build custom or use existing OpenCode web UI?

---

## Architecture Options

### Option A: Cloud-Only (Cloudflare Workers + Sandbox)

- Webhook server runs on Cloudflare Workers
- Each session spawns a Sandbox container with the target repo
- Always available, no sleep issues
- Managed infrastructure

### Option B: Local Server + Cloud Tunnel

- Single OpenCode server running locally (always-on machine or accept downtime)
- Cloudflare Tunnel exposes webhook endpoint
- Multiple server instances for multiple projects, or dynamic project switching
- Lower cost, data stays local

### Option C: Hybrid

- Local TUI for development (no Docker)
- Cloud deployment for Linear agent / remote access
- Separate but equivalent experiences

---

## Next Steps

1. Decide on execution environment (cloud vs. local vs. hybrid)
2. Investigate OpenCode's multi-project capabilities
3. Design project selection mechanism for remote sessions
4. Prototype simplified local setup (no Docker)
