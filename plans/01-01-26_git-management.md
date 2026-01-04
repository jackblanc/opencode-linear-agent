# Git Management & Session Isolation Plan

**Date**: January 1, 2026  
**Status**: Draft  
**Goal**: Fix the Linear OpenCode Agent so that changes are committed/pushed, sessions are isolated, and Linear shows a link to the OpenCode UI.

---

## Problems

1. **Changes are lost** - The agent doesn't commit and push changes before session completion
2. **No OpenCode UI link** - Linear session doesn't link to the OpenCode web interface
3. **No session isolation** - All sessions share `/workspace`, preventing parallel work
4. **Wrong directory in git-status-hook** - Uses `/home/user/project` instead of actual working directory

---

## Solution Overview

### Architecture Changes

1. **Per-session git worktrees** - Each Linear session gets its own worktree with a dedicated branch
2. **Git status gating** - The Linear plugin refuses to send the Stop signal until git status is clean
3. **External URL** - Set `externalUrl` on the Linear session to link to OpenCode UI
4. **Consolidate plugins** - Merge git-status-hook into the Linear plugin for coordinated control

### Directory Structure (In Sandbox)

```
/workspace/
├── repo/                              # Main clone (source for worktrees)
│   ├── .git/
│   └── ...
└── sessions/
    ├── {linear-session-id-1}/         # Worktree for session 1
    │   ├── .git                       # (file pointing to main repo)
    │   └── ... (project files)
    ├── {linear-session-id-2}/         # Worktree for session 2
    │   └── ...
    └── ...
```

### Branch Naming

Format: `linear-opencode-agent/{issue-id}/{session-id}`

Example: `linear-opencode-agent/abc123-def456/xyz789-uvw012`

---

## Execution Flow

```
1. Linear webhook received (AgentSessionEvent)
   │
2. Extract organizationId, linearSessionId, issueId from payload
   │
3. Send immediate acknowledgment to Linear
   │
4. ensureSessionWorktree()
   ├── Clone main repo to /workspace/repo (if not exists)
   ├── Fetch existing branch OR create new branch
   ├── Create worktree at /workspace/sessions/{session-id}
   ├── Configure git user.name, user.email
   ├── Set remote URL with auth token
   └── Run bun install
   │
5. getOrInitializeSandbox(env, orgId, sessionWorkdir)
   ├── Mount R2 bucket
   ├── Set LINEAR_ACCESS_TOKEN
   └── Create OpenCode with session-specific directory
   │
6. getOrCreateSession() - create/resume OpenCode session
   │
7. Set externalUrl on Linear session → links to OpenCode UI
   │
8. Start OpenCode prompt (async)
   │
   ... agent works ...
   │
9. session.idle fires
   │
10. Linear plugin checks git status:
    ├── IF uncommitted changes → prompt agent to commit, DO NOT send Stop
    ├── IF unpushed commits → prompt agent to push & create PR, DO NOT send Stop
    └── IF clean → send Stop signal, session completes
    │
11. Agent commits, pushes, creates PR (if prompted)
    │
12. session.idle fires again → now clean → Stop signal sent
```

---

## Files to Change

### 1. `packages/worker/src/sandbox.ts`

**Changes**:

- Add `REPO_DIR = "/workspace/repo"` constant
- Add `getSessionWorkdir(sessionId: string): string` helper
- Modify `getOrInitializeSandbox()` to accept optional `workdir` parameter

```typescript
// New exports
export const REPO_DIR = "/workspace/repo";

export function getSessionWorkdir(sessionId: string): string {
  return `/workspace/sessions/${sessionId}`;
}

// Modified signature
export async function getOrInitializeSandbox(
  env: Env,
  organizationId: string,
  workdir?: string // NEW: optional override for PROJECT_DIR
): Promise<SandboxContext>;
```

---

### 2. `packages/worker/src/webhook.ts`

**Changes**:

#### a) Add `ensureSessionWorktree()` function

Replaces `ensureRepoCloned()`. Handles:

- Main repo clone (if needed)
- Branch creation or fetch (for resume)
- Worktree creation
- Git config (user.name, user.email, remote URL with token)
- Dependency installation

```typescript
interface WorktreeResult {
  workdir: string;
  branchName: string;
}

async function ensureSessionWorktree(
  env: Env,
  linearSessionId: string,
  issueId: string,
  linearClient: LinearClient
): Promise<WorktreeResult>;
```

#### b) Set `externalUrl` on Linear session

After creating/resuming the OpenCode session:

```typescript
const workerUrl = new URL(request.url).origin;
const externalUrl = `${workerUrl}/opencode?session=${opencodeSessionId}`;

await linearClient.agentSessionUpdate(linearSessionId, {
  externalUrl,
});
```

#### c) Extract `issueId` from payload

```typescript
const issueId = payload.agentSession.issue?.id ?? payload.agentSession.issueId;
```

#### d) Update `SessionState` interface

```typescript
interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  issueId: string; // NEW
  branchName: string; // NEW
  lastActivityTime: number;
}
```

#### e) Pass request to `processAgentSessionEvent()`

Need access to `request.url` to derive worker URL for `externalUrl`.

---

### 3. `packages/opencode-linear-plugin/src/index.ts`

**Changes**:

#### a) Add git status check helper

```typescript
interface GitCheckResult {
  action: "commit" | "push" | "complete";
  branchName: string;
}

async function checkGitStatusForCompletion(
  workdir: string
): Promise<GitCheckResult>;
```

#### b) Modify `session.idle` handler

Replace current Stop signal logic with git status gating:

```typescript
if (event.type === "session.idle") {
  const workdir = process.cwd();
  const gitCheck = await checkGitStatusForCompletion(workdir);

  if (gitCheck.action === "commit") {
    // Prompt agent to commit - DO NOT send Stop signal
    await client.session.promptAsync({
      path: { id: opencodeSessionId },
      body: {
        parts: [
          {
            type: "text",
            text: buildCommitPrompt(gitCheck.branchName),
          },
        ],
      },
    });
    return;
  }

  if (gitCheck.action === "push") {
    // Prompt agent to push and create PR - DO NOT send Stop signal
    await client.session.promptAsync({
      path: { id: opencodeSessionId },
      body: {
        parts: [
          {
            type: "text",
            text: buildPushPrompt(gitCheck.branchName),
          },
        ],
      },
    });
    return;
  }

  // Clean - send Stop signal
  await sendLinearActivity(
    linearClient,
    linearSessionId,
    { type: "thought", body: "Task completed." },
    false,
    AgentActivitySignal.Stop
  );
}
```

---

### 4. `packages/opencode-linear-agent/src/git-status-hook.ts`

**Action**: DELETE this file

Functionality is merged into the main Linear plugin for coordinated control over session completion.

---

### 5. `Dockerfile`

**Changes**:

Remove the git-status-hook build step:

```dockerfile
# REMOVE THIS LINE:
&& bun build src/git-status-hook.ts --outdir /root/.config/opencode/plugin --outfile git-status-hook.js --target bun --format esm \
```

---

## Session Resume Handling

When a `prompted` webhook arrives for an existing session:

1. Retrieve `SessionState` from KV (includes `issueId`, `branchName`)
2. Check if worktree exists at `/workspace/sessions/{session-id}`
3. If worktree missing (container restarted):
   - Ensure main repo exists
   - Fetch the remote branch: `git fetch origin {branchName}`
   - Create worktree from existing branch: `git worktree add {workdir} {branchName}`
   - Run `bun install`
4. Continue with OpenCode prompt

**Note**: Uncommitted changes are lost on container restart. The git status gating ensures changes are committed before session completion, minimizing this risk.

---

## Prompt Templates

### Commit Prompt

```
[git-status-check]: You have uncommitted changes in the repository.

Please:
1. Stage and commit all changes with a descriptive commit message
2. Push to the remote branch: {branchName}
3. Create a pull request for your changes

Do not stop until all changes are committed and pushed.
```

### Push Prompt

```
[git-status-check]: You have unpushed commits on branch {branchName}.

Please:
1. Push your commits: git push origin {branchName}
2. Create a pull request for your changes

Do not stop until changes are pushed and a PR is created.
```

---

## Edge Cases

| Scenario                               | Handling                                                |
| -------------------------------------- | ------------------------------------------------------- |
| Session resume after container restart | Recreate worktree from remote branch                    |
| Branch already exists (resume)         | Fetch and checkout existing branch                      |
| Worktree already exists                | Skip creation, reuse existing                           |
| Two webhooks race for same session     | Worktree existence check handles gracefully             |
| Clone/worktree creation fails          | Report error to Linear via `agentActivity` type `error` |
| No upstream set for push check         | Fall back to checking commits since origin/main         |

---

## Testing Checklist

- [ ] New session creates worktree with correct branch name
- [ ] Branch name format: `linear-opencode-agent/{issue-id}/{session-id}`
- [ ] Resumed session reuses existing worktree
- [ ] Container restart + resume recreates worktree from remote
- [ ] OpenCode UI link appears in Linear session (externalUrl)
- [ ] Session cannot complete with uncommitted changes
- [ ] Session cannot complete with unpushed commits
- [ ] Agent successfully commits and pushes
- [ ] Agent creates PR
- [ ] Multiple parallel sessions work independently
- [ ] Git user.name and user.email are configured correctly
- [ ] Push works (remote URL has auth token)

---

## Environment Variables

**Existing (no changes)**:

- `GITHUB_TOKEN` - Used for clone and push
- `REPO_URL` - Repository URL
- `LINEAR_WEBHOOK_SECRET` - Webhook signature verification
- `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` - OAuth
- `ANTHROPIC_API_KEY` - AI provider
- `ADMIN_API_KEY` - Basic auth for OpenCode UI

**No new env vars needed** - Worker URL derived from request.

---

## Complexity Assessment

| Component                 | Complexity | Notes                                |
| ------------------------- | ---------- | ------------------------------------ |
| sandbox.ts changes        | Low        | Add constants and helper function    |
| webhook.ts worktree setup | Medium     | New function with git operations     |
| webhook.ts externalUrl    | Low        | Simple API call                      |
| Linear plugin git gating  | Medium     | New logic, replaces existing         |
| Delete git-status-hook    | Low        | Just delete file and Dockerfile line |
| Session resume handling   | Medium     | Branch fetch and worktree recreation |

**Overall**: Medium complexity - mostly additive changes with clear control flow.
