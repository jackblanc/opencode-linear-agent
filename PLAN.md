# Implementation Plan: Fix & Secure Linear OpenCode Agent

## Overview

This plan restructures the project into Bun workspaces, fixes critical bugs, adds security, and makes the plugin easier to debug. The plugin will be refactored to use `@linear/sdk` instead of raw GraphQL fetch calls.

---

## Current State Analysis

### Critical Bugs (Project Does Not Work)

| Issue                                 | Location                     | Description                                                                                                                                           |
| ------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin doesn't receive token          | `plugin/linear-agent.ts:222` | Reads `process.env.LINEAR_ACCESS_TOKEN` at initialization time, but `sandbox.setEnvVars()` may not have executed yet. Token is cached as `undefined`. |
| Repo clone state persists incorrectly | `src/webhook.ts:119-147`     | Stores "cloned" state in KV. After container restart, code thinks repo exists when it doesn't.                                                        |
| Hardcoded repository                  | `src/webhook.ts:11`          | Always uses `https://github.com/sst/opencode`. No way to configure.                                                                                   |
| Dead code                             | `src/mapping.ts`             | Entire file is unused - exports `mapPartToActivity` and `mapErrorToActivity` but nothing imports them.                                                |

### Security Vulnerabilities

| Issue                       | Location                         | Description                                                                                            |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/api/test` unauthenticated | `src/index.ts:53-55`             | Anyone can create OpenCode sessions and run AI prompts. Costs money, exposes API key usage.            |
| OpenCode UI exposed         | `src/index.ts:58-70`             | Routes `/session/*`, `/event/*`, `/opencode/*` have no authentication. Full OpenCode access to anyone. |
| Token prefix logged         | `plugin/linear-agent.ts:235-242` | Logs first 10 characters of Linear access token. Logs may be stored or accessible.                     |
| GitHub token in URL         | `src/webhook.ts:136-139`         | Token embedded in clone URL string. Git commands may log this URL.                                     |

### Configuration Issues

| Issue                                       | Location               | Description                                                                   |
| ------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `GITHUB_TOKEN` marked optional but required | `.dev.vars.example:12` | Comment says "Optional" but code uses it unconditionally at `webhook.ts:138`. |
| No repo configuration mechanism             | -                      | Users cannot specify which repository the agent should work on.               |

---

## Target Architecture

```
linear-opencode-agent/
├── packages/
│   ├── worker/                              # Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts                    # Request routing, auth checks
│   │   │   ├── auth.ts                     # API key validation helper
│   │   │   ├── oauth.ts                    # Linear OAuth flow (mostly unchanged)
│   │   │   ├── webhook.ts                  # Linear webhook handler (fixed)
│   │   │   └── config.ts                   # OpenCode configuration
│   │   ├── Dockerfile                      # Updated to copy plugin from sibling
│   │   ├── wrangler.jsonc                  # Updated paths
│   │   ├── package.json                    # Worker-specific dependencies
│   │   ├── tsconfig.json                   # Extends root config
│   │   └── worker-configuration.d.ts       # Generated Cloudflare types
│   │
│   └── opencode-linear-agent/              # Plugin package (local, not published)
│       ├── src/
│       │   └── index.ts                    # Refactored plugin using @linear/sdk
│       ├── dist/                           # Build output (gitignored)
│       │   └── index.js
│       ├── package.json                    # Plugin dependencies
│       ├── tsconfig.json                   # Extends root config
│       └── README.md                       # Plugin documentation
│
├── package.json                            # Root workspace configuration
├── tsconfig.json                           # Base TypeScript configuration
├── bun.lock
├── .gitignore                              # Updated for new structure
├── .dev.vars.example                       # Updated with new variables
├── AGENTS.md                               # Updated for new structure
├── PLAN.md                                 # This file
└── README.md                               # Updated for new structure
```

---

## Environment Variables

### New Variables Required

| Variable        | Purpose                                  | Example                                     |
| --------------- | ---------------------------------------- | ------------------------------------------- |
| `ADMIN_API_KEY` | Protects OpenCode UI and admin endpoints | `sk-admin-xxxxxxxxxxxx`                     |
| `REPO_URL`      | Repository the agent works on            | `https://github.com/jackblanc/reservations` |

### Updated `.dev.vars.example`

```
# Anthropic API key for OpenCode
ANTHROPIC_API_KEY=sk-ant-...

# Linear OAuth Config
LINEAR_CLIENT_ID=...
LINEAR_CLIENT_SECRET=...

# Linear webhook secret (from Linear app settings)
LINEAR_WEBHOOK_SECRET=...

# GitHub token for cloning repositories (required)
GITHUB_TOKEN=ghp_...

# Admin API key for accessing OpenCode UI (required)
ADMIN_API_KEY=generate-a-secure-random-string

# Repository URL for the agent to work on (required)
REPO_URL=https://github.com/jackblanc/reservations
```

### Secrets to Add in Production

```bash
wrangler secret put ADMIN_API_KEY
wrangler secret put REPO_URL
```

---

## Detailed Task List

### Phase 1: Workspace Setup

#### Task 1.1: Create Root Workspace Configuration

**File**: `package.json` (root, new)

- Set `"private": true`
- Configure `"workspaces": ["packages/*"]`
- Add workspace-level scripts:
  - `build` - builds all packages
  - `typecheck` - typechecks all packages
  - `dev` - runs worker locally
  - `lint:check`, `lint:fix` - linting
  - `format:check`, `format:fix` - formatting
  - `check` - runs all checks
- Move shared devDependencies from current `package.json`:
  - `typescript`
  - `prettier`
  - `oxlint`
  - `@cloudflare/workers-types`
  - `wrangler`

#### Task 1.2: Create Base TypeScript Configuration

**File**: `tsconfig.json` (root, new)

- Set as base config that packages extend
- Configure:
  - `target`: `ESNext`
  - `module`: `ESNext`
  - `moduleResolution`: `bundler`
  - `strict`: `true`
  - `skipLibCheck`: `true`
  - `noEmit`: `true` (base config, packages override)

#### Task 1.3: Update `.gitignore`

**File**: `.gitignore` (modify)

- Add `packages/*/dist/`
- Add `packages/*/.wrangler/`
- Keep existing ignores

---

### Phase 2: Worker Package Setup

#### Task 2.1: Create Worker Package Directory

**Actions**:

- Create `packages/worker/` directory
- Create `packages/worker/src/` directory

#### Task 2.2: Move Worker Source Files

**Move**:

- `src/index.ts` → `packages/worker/src/index.ts`
- `src/oauth.ts` → `packages/worker/src/oauth.ts`
- `src/webhook.ts` → `packages/worker/src/webhook.ts`
- `src/config.ts` → `packages/worker/src/config.ts`
- `Dockerfile` → `packages/worker/Dockerfile`
- `wrangler.jsonc` → `packages/worker/wrangler.jsonc`
- `worker-configuration.d.ts` → `packages/worker/worker-configuration.d.ts`

**Delete** (do not move):

- `src/mapping.ts` - dead code, unused
- `src/types.ts` - mostly unused, SDK provides types

#### Task 2.3: Create Worker Package Configuration

**File**: `packages/worker/package.json` (new)

- Name: `@linear-opencode-agent/worker`
- Private: true
- Dependencies (move from root):
  - `@cloudflare/sandbox`
- Scripts:
  - `dev` - `wrangler dev`
  - `deploy` - `wrangler deploy`
  - `typecheck` - `tsc --noEmit`
  - `cf-typegen` - `wrangler types`

**File**: `packages/worker/tsconfig.json` (new)

- Extends root `tsconfig.json`
- Set `include`: `["src/**/*", "worker-configuration.d.ts"]`

#### Task 2.4: Update Wrangler Configuration

**File**: `packages/worker/wrangler.jsonc` (modify)

- Update `main` path to `src/index.ts`
- Paths are now relative to `packages/worker/`

---

### Phase 3: Plugin Package Setup

#### Task 3.1: Create Plugin Package Directory

**Actions**:

- Create `packages/opencode-linear-agent/` directory
- Create `packages/opencode-linear-agent/src/` directory

#### Task 3.2: Create Plugin Package Configuration

**File**: `packages/opencode-linear-agent/package.json` (new)

- Name: `opencode-linear-agent`
- Version: `0.1.0`
- Private: true (for now, can publish later)
- Main: `dist/index.js`
- Scripts:
  - `build` - bundle with esbuild or bun build
  - `typecheck` - `tsc --noEmit`
  - `dev` - `bun build --watch`
- Dependencies:
  - `@linear/sdk` - Linear's official TypeScript SDK
- DevDependencies:
  - `@types/node`

**File**: `packages/opencode-linear-agent/tsconfig.json` (new)

- Extends root `tsconfig.json`
- Override `noEmit`: false
- Set `outDir`: `dist`
- Set `declaration`: true
- Set `include`: `["src/**/*"]`

**File**: `packages/opencode-linear-agent/README.md` (new)

- Document plugin purpose
- Document required environment variables (`LINEAR_ACCESS_TOKEN`)
- Document how it integrates with OpenCode hooks

---

### Phase 4: Security Implementation

#### Task 4.1: Create Auth Helper

**File**: `packages/worker/src/auth.ts` (new)

**Purpose**: Validate API key from query parameter

**Function**: `validateApiKey(request: Request, env: Env): boolean`

- Extract `key` query parameter from URL
- Compare against `env.ADMIN_API_KEY`
- Return `true` if valid, `false` otherwise

**Function**: `unauthorizedResponse(): Response`

- Return 401 JSON response with error message

#### Task 4.2: Protect OpenCode UI Routes

**File**: `packages/worker/src/index.ts` (modify)

**Changes**:

1. Import auth helpers from `./auth.ts`
2. Before routing to OpenCode UI paths, validate API key:
   - `/session/*`
   - `/event/*`
   - `/opencode/*`
   - Root `/` (OpenCode Web UI)
3. If invalid, return 401 response
4. If valid, proceed to `proxyToOpencode()`

**Protected route pattern**:

```
GET/POST /session/* - requires ?key=ADMIN_API_KEY
GET/POST /event/* - requires ?key=ADMIN_API_KEY
GET/POST /opencode/* - requires ?key=ADMIN_API_KEY
GET / - requires ?key=ADMIN_API_KEY (OpenCode Web UI)
```

**Unprotected routes** (unchanged):

```
GET /health - public health check
GET /oauth/authorize - starts OAuth flow
GET /oauth/callback - OAuth redirect (CSRF protected via state)
POST /webhook/linear - protected by webhook signature verification
```

#### Task 4.3: Remove `/api/test` Endpoint

**File**: `packages/worker/src/index.ts` (modify)

**Changes**:

- Delete the route handler for `POST /api/test`
- Remove associated code that creates test sessions

#### Task 4.4: Update Worker Types

**File**: `packages/worker/worker-configuration.d.ts` (regenerate)

**Changes**:

- Run `wrangler types` after adding new env vars
- Should include `ADMIN_API_KEY` and `REPO_URL`

---

### Phase 5: Plugin Refactor

#### Task 5.1: Rewrite Plugin Using Linear SDK

**File**: `packages/opencode-linear-agent/src/index.ts` (new, replaces `plugin/linear-agent.ts`)

**Structure**:

1. **Imports**:
   - Import `LinearClient` from `@linear/sdk`
   - Import types from `@opencode-ai/plugin` (Plugin, hooks, etc.)

2. **Client Initialization**:
   - Create `getLinearClient()` function that:
     - Reads `process.env.LINEAR_ACCESS_TOKEN` fresh each time (NOT cached)
     - Returns `null` if token not available
     - Creates and returns `new LinearClient({ accessToken })`

3. **Activity Creation**:
   - Replace raw GraphQL fetch with `linearClient.createAgentActivity()`
   - SDK method signature handles typing automatically

4. **Plan Updates**:
   - Replace raw GraphQL mutation with `linearClient.agentSessionUpdate()`
   - Convert todo items to plan steps format

5. **Hook Handlers**:
   - `session.create` - Create Linear agent session, store mapping
   - `session.delete` - Clean up (optional)
   - `chat.message` - Process assistant messages, create activities
   - `tool.call` - Create "action" activities for tool usage
   - `event` - Handle completion, send final plan update

6. **Session Mapping**:
   - Keep in-memory cache for OpenCode session ID → Linear session ID
   - Fetch from OpenCode API if not in cache (existing logic)
   - Note: This cache is acceptable to lose on restart since it can be rebuilt

7. **Remove**:
   - Token prefix logging (security fix)
   - `LINEAR_API` constant and raw fetch calls
   - Manually constructed GraphQL queries

#### Task 5.2: Delete Old Plugin Location

**Delete**: `plugin/linear-agent.ts`

- File moved to `packages/opencode-linear-agent/src/index.ts`
- Remove empty `plugin/` directory

---

### Phase 6: Webhook Handler Fixes

#### Task 6.1: Remove Repo Clone State Persistence

**File**: `packages/worker/src/webhook.ts` (modify)

**Current behavior** (broken):

1. Check KV for `org-repo:{orgId}` key
2. If exists, skip cloning
3. If not, clone and set key to "true"

**Problem**: After container restart, KV says "cloned" but container is fresh.

**New behavior**:

1. Always check if repo directory exists in container: `sandbox.exec("test -d /home/user/project/.git")`
2. If exists, skip cloning
3. If not, clone (don't store anything in KV)

**Remove**:

- `const orgRepoKey = \`org-repo:${organizationId}\``
- `await env.LINEAR_TOKENS.get(orgRepoKey)`
- `await env.LINEAR_TOKENS.put(orgRepoKey, "true")`

#### Task 6.2: Use Environment Variable for Repository URL

**File**: `packages/worker/src/webhook.ts` (modify)

**Current**:

```typescript
const REPO_URL = "https://github.com/sst/opencode";
```

**New**:

```typescript
// Read from environment, with validation
const repoUrl = env.REPO_URL;
if (!repoUrl) {
  return Response.json({ error: "REPO_URL not configured" }, { status: 500 });
}
```

#### Task 6.3: Fix GitHub Token Exposure

**File**: `packages/worker/src/webhook.ts` (modify)

**Current** (token in URL string):

```typescript
const authenticatedUrl = REPO_URL.replace(
  "https://",
  `https://x-access-token:${env.GITHUB_TOKEN}@`,
);
await sandbox.gitCheckout(authenticatedUrl, PROJECT_DIR);
```

**New** (use git credential helper or config):

```typescript
// Option 1: Set git credential before clone
await sandbox.exec(
  `git config --global credential.helper '!f() { echo "password=${env.GITHUB_TOKEN}"; }; f'`,
);
await sandbox.gitCheckout(repoUrl, PROJECT_DIR);

// Option 2: If gitCheckout doesn't support credentials, use exec
await sandbox.exec(
  `git clone https://x-access-token:${env.GITHUB_TOKEN}@${repoUrl.replace("https://", "")} ${PROJECT_DIR}`,
  {
    // Ensure output is not logged
  },
);
```

**Note**: Verify which approach works with Cloudflare Sandbox SDK. The goal is to avoid the token appearing in any logged output.

---

### Phase 7: Dockerfile Update

#### Task 7.1: Update Dockerfile to Copy Built Plugin

**File**: `packages/worker/Dockerfile` (modify)

**Current**:

```dockerfile
COPY plugin/linear-agent.ts /home/user/.config/opencode/plugin/linear-agent.ts
```

**New**:

```dockerfile
# Copy the built plugin from the sibling package
COPY packages/opencode-linear-agent/dist/index.js /home/user/.config/opencode/plugin/linear-agent.js
```

**Note**: The build process must build the plugin before running `wrangler deploy`. Update deployment workflow accordingly.

---

### Phase 8: Documentation Updates

#### Task 8.1: Update `.dev.vars.example`

**File**: `.dev.vars.example` (modify)

Add new required variables with clear documentation.

#### Task 8.2: Update `AGENTS.md`

**File**: `AGENTS.md` (modify)

- Update project structure section
- Update build commands for workspaces
- Update file paths
- Add new environment variables documentation

#### Task 8.3: Update Root `README.md`

**File**: `README.md` (modify)

- Document workspace structure
- Document local development setup
- Document environment variables
- Document how to access OpenCode UI (with API key)

---

### Phase 9: Build & Deployment Updates

#### Task 9.1: Update GitHub Actions Workflow

**File**: `.github/workflows/deploy.yml` (modify)

**Add steps**:

1. Install dependencies at root: `bun install`
2. Build plugin: `bun run --filter opencode-linear-agent build`
3. Build/deploy worker: `bun run --filter worker deploy`

**Order matters**: Plugin must be built before worker deployment (Dockerfile copies built plugin).

---

## File Change Summary

### New Files (8)

| File                                           | Purpose                 |
| ---------------------------------------------- | ----------------------- |
| `package.json` (root)                          | Workspace configuration |
| `tsconfig.json` (root)                         | Base TypeScript config  |
| `packages/worker/package.json`                 | Worker dependencies     |
| `packages/worker/tsconfig.json`                | Worker TS config        |
| `packages/opencode-linear-agent/package.json`  | Plugin dependencies     |
| `packages/opencode-linear-agent/tsconfig.json` | Plugin TS config        |
| `packages/opencode-linear-agent/src/index.ts`  | Refactored plugin       |
| `packages/opencode-linear-agent/README.md`     | Plugin documentation    |
| `packages/worker/src/auth.ts`                  | API key validation      |

### Moved Files (6)

| From                        | To                                          |
| --------------------------- | ------------------------------------------- |
| `src/index.ts`              | `packages/worker/src/index.ts`              |
| `src/oauth.ts`              | `packages/worker/src/oauth.ts`              |
| `src/webhook.ts`            | `packages/worker/src/webhook.ts`            |
| `src/config.ts`             | `packages/worker/src/config.ts`             |
| `Dockerfile`                | `packages/worker/Dockerfile`                |
| `wrangler.jsonc`            | `packages/worker/wrangler.jsonc`            |
| `worker-configuration.d.ts` | `packages/worker/worker-configuration.d.ts` |

### Modified Files (5)

| File                             | Changes                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `packages/worker/src/index.ts`   | Add auth, remove `/api/test`, protect OpenCode routes     |
| `packages/worker/src/webhook.ts` | Fix clone state, use env var for repo, fix token exposure |
| `packages/worker/Dockerfile`     | Copy plugin from built package                            |
| `.dev.vars.example`              | Add new environment variables                             |
| `.github/workflows/deploy.yml`   | Build plugin before deploy                                |
| `AGENTS.md`                      | Update for new structure                                  |
| `.gitignore`                     | Add new paths                                             |

### Deleted Files (3)

| File                     | Reason                             |
| ------------------------ | ---------------------------------- |
| `src/mapping.ts`         | Dead code - never imported         |
| `src/types.ts`           | Mostly unused - SDK provides types |
| `plugin/linear-agent.ts` | Moved to package                   |

### Deleted Directories (2)

| Directory | Reason                                                  |
| --------- | ------------------------------------------------------- |
| `src/`    | Contents moved to `packages/worker/src/`                |
| `plugin/` | Contents moved to `packages/opencode-linear-agent/src/` |

---

## Testing Plan

### Local Development Testing

1. **Workspace setup**:
   - Run `bun install` at root
   - Verify all packages have node_modules symlinked

2. **Plugin build**:
   - Run `bun run --filter opencode-linear-agent build`
   - Verify `packages/opencode-linear-agent/dist/index.js` exists

3. **Worker typecheck**:
   - Run `bun run --filter worker typecheck`
   - Verify no type errors

4. **Local dev server**:
   - Set up `.dev.vars` with all required variables
   - Run `bun run dev`
   - Verify worker starts

5. **Auth testing**:
   - Access `http://localhost:8787/` without key → expect 401
   - Access `http://localhost:8787/?key=YOUR_KEY` → expect OpenCode UI

6. **Webhook testing**:
   - Send test webhook with valid signature
   - Verify repo cloning works
   - Verify plugin receives events

### Production Deployment Testing

1. Deploy to Cloudflare
2. Verify OAuth flow still works
3. Verify webhook handling works
4. Verify OpenCode UI accessible with API key
5. Verify OpenCode UI blocked without API key

---

## Rollback Plan

If issues arise after deployment:

1. **Immediate**: Revert to previous deployment via Wrangler

   ```bash
   wrangler rollback
   ```

2. **Code**: Git revert to pre-refactor commit

   ```bash
   git revert HEAD~N  # where N is number of commits
   ```

3. **Secrets**: No secrets are removed, only added. Rollback doesn't affect secrets.

---

## Success Criteria

- [ ] `bun install` works at root and sets up all packages
- [ ] `bun run build` builds plugin successfully
- [ ] `bun run typecheck` passes with no errors
- [ ] `bun run dev` starts local development server
- [ ] OpenCode UI returns 401 without API key
- [ ] OpenCode UI loads with valid API key in query param
- [ ] `/health` endpoint works without auth
- [ ] `/oauth/authorize` initiates OAuth flow
- [ ] `/webhook/linear` processes webhooks (with valid signature)
- [ ] Plugin receives `LINEAR_ACCESS_TOKEN` and creates activities
- [ ] Repo cloning works after container restart (no stale KV state)
- [ ] No sensitive tokens appear in logs
