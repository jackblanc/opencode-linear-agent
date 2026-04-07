# Plan: Simplify Repo Resolution

## Summary

Remove filesystem-based repo discovery, complex resolution, and all unused config. Replace with simple label-to-path mapping:

- `repo:X` → `{projectsPath}/X`
- No label → `{projectsPath}` (run in projects dir itself, no worktree)

## Background

The webhook server previously ran in Docker with a volume mount to `~/projects`, and auto-discovered git repos. Now OpenCode runs on the host (via launchd), so:

1. The webhook server doesn't need filesystem access to repos
2. Paths sent to OpenCode must be host paths, not container paths
3. `~/opencode-worktrees` is a leftover from old architecture

## Files to DELETE

| File                                   | Reason                                    |
| -------------------------------------- | ----------------------------------------- |
| `packages/server/src/RepoDiscovery.ts` | No longer needed - no filesystem scanning |

## Files to MODIFY

### 1. `packages/server/src/RepoResolver.ts`

**Replace entire file** with simple function (~35 lines):

```typescript
import { join } from "node:path";
import { Result } from "better-result";
import { parseRepoLabel, Log, type LinearService } from "@opencode-linear-agent/core";

export interface ResolvedRepo {
  path: string;
  repoName: string | null;
}

/**
 * Resolve repository path from issue labels
 * - repo:X → projectsPath/X
 * - repo:org/X → projectsPath/X (org ignored)
 * - no label → projectsPath (no worktree)
 */
export async function resolveRepoPath(
  linear: LinearService,
  issueId: string,
  projectsPath: string,
): Promise<Result<ResolvedRepo, Error>> {
  const log = Log.create({ service: "repo-resolver" }).tag("issueId", issueId);

  const labelsResult = await linear.getIssueLabels(issueId);
  if (Result.isError(labelsResult)) {
    return labelsResult;
  }

  const repoLabel = parseRepoLabel(labelsResult.value);

  if (!repoLabel) {
    log.info("No repo label, using projectsPath root", { projectsPath });
    return Result.ok({ path: projectsPath, repoName: null });
  }

  const repoPath = join(projectsPath, repoLabel.repositoryName);
  log.info("Resolved repo from label", {
    repoName: repoLabel.repositoryName,
    repoPath,
  });

  return Result.ok({ path: repoPath, repoName: repoLabel.repositoryName });
}
```

### 2. `packages/server/src/config.ts`

**Remove:**

- `RepoConfig` interface
- `repo?: RepoConfig` field
- `repos?: Record<string, RepoConfig>` field
- `defaultRepo?: string` field
- `github` config block entirely
- `paths.repos` field
- `paths.workspace` field
- All `repo`/`repos` validation logic
- All repo path expansion logic

**Add:**

- `projectsPath: string` field in Config interface
- Validation for `projectsPath`
- Path expansion for `projectsPath`

**New Config interface:**

```typescript
export interface Config {
  port: number;
  publicHostname: string;
  opencode: {
    url: string;
  };
  linear: {
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    organizationId: string;
    webhookIps: string[];
  };
  projectsPath: string;
  paths: {
    data: string;
  };
}
```

### 3. `packages/server/src/index.ts`

**Remove:**

- Import of `RepoResolver` class
- Import/dynamic import of `discoverRepos`
- `availableRepos` variable
- All repo discovery logic
- Complex error message with availableRepos
- Logging of `discoveredRepos`, `configuredRepos`, `defaultRepo`, `worktreesPath`

**Add:**

- Import of `resolveRepoPath` function

**Simplified `createDirectDispatcher`:**

```typescript
const resolveResult = await resolveRepoPath(linear, issueId, config.projectsPath);

if (Result.isError(resolveResult)) {
  log.error("Failed to resolve repository", {
    error: resolveResult.error.message,
  });
  await linear.postError(linearSessionId, resolveResult.error);
  return;
}

const { path: repoPath, repoName } = resolveResult.value;
log.info("Using repository path", { repoPath, repoName });

const processor = new EventProcessor(opencode, linear, sessionRepository, repoPath, {
  opencodeUrl: config.opencode.url,
});
```

**Simplified startup logging:**

```typescript
log.info("Configuration loaded", {
  port: config.port,
  publicHostname: config.publicHostname,
  opencodeUrl: config.opencode.url,
  projectsPath: config.projectsPath,
});
```

### 4. `docker-compose.yml`

**Remove:**

```yaml
- ${PROJECTS_DIR:-~/projects}:/home/user/projects:ro
```

### 5. `packages/server/Dockerfile`

**Remove:**

```dockerfile
# Install git for repo discovery
RUN apk add --no-cache git
```

Git is no longer needed in the webhook server container.

### 6. `config.docker.json`

**Before:**

```json
{
  "port": 3000,
  "publicHostname": "linear-webhook.jackblanc.com",
  "opencode": { "url": "http://host.docker.internal:4096" },
  "linear": { ... },
  "github": { "token": "..." },
  "paths": {
    "repos": "/home/user/projects",
    "workspace": "/workspace",
    "data": "/data"
  }
}
```

**After:**

```json
{
  "port": 3000,
  "publicHostname": "linear-webhook.jackblanc.com",
  "opencode": { "url": "http://host.docker.internal:4096" },
  "linear": { ... },
  "projectsPath": "/Users/jackblanc/projects",
  "paths": {
    "data": "/data"
  }
}
```

### 7. `packages/server/config.example.json`

**After:**

```json
{
  "port": 3000,
  "publicHostname": "your-hostname.com",
  "opencode": { "url": "http://host.docker.internal:4096" },
  "linear": {
    "clientId": "YOUR_LINEAR_CLIENT_ID",
    "clientSecret": "YOUR_LINEAR_CLIENT_SECRET",
    "webhookSecret": "YOUR_LINEAR_WEBHOOK_SECRET",
    "organizationId": "YOUR_LINEAR_ORGANIZATION_ID",
    "webhookIps": [
      "35.231.147.226",
      "35.243.134.228",
      "34.140.253.14",
      "34.38.87.206",
      "34.134.222.122",
      "35.222.25.142"
    ]
  },
  "projectsPath": "/path/to/your/projects",
  "paths": {
    "data": "/data"
  }
}
```

### 8. `packages/server/config.json` (local dev config)

Update to match new schema - remove `repo`, `repos`, `github`, `paths.repos`, `paths.workspace`, add `projectsPath`.

### 9. `AGENTS.md`

**Remove/Update:**

- Remove row for `~/opencode-worktrees` from Container Paths table
- Remove mention of `RepoDiscovery.ts` from Project Structure
- Update config example (remove `github`, `paths.repos`, `paths.workspace`, add `projectsPath`)
- Remove note about auto-discovery
- Remove `GITHUB_TOKEN` from Environment Variables table

## Manual Cleanup (after deploy verified working)

```bash
rm -rf ~/opencode-worktrees
```

## Summary of Changes

| What                 | Change                           |
| -------------------- | -------------------------------- |
| `RepoDiscovery.ts`   | DELETE (~123 lines)              |
| `RepoResolver.ts`    | REPLACE (~200 lines → ~35 lines) |
| `config.ts`          | SIMPLIFY (~80 lines removed)     |
| `index.ts`           | SIMPLIFY (~30 lines removed)     |
| `docker-compose.yml` | Remove volume mount              |
| `Dockerfile`         | Remove git install               |
| Config files         | Update schema                    |
| `AGENTS.md`          | Update docs                      |
| **Total**            | **~400+ lines removed**          |

## Complexity

Low-Medium - mostly deletion and simplification.
