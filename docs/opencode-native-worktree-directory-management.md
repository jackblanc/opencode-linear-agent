# OpenCode Worktree and Directory Management

This document summarizes how OpenCode manages git worktrees and working directories, useful for agents that need isolated environments.

## Single Server, Multiple Projects

OpenCode's server is **project-agnostic**. A single server instance can serve all your projects without needing to restart or reconfigure.

### Directory Resolution

Every API request specifies its directory context via (in priority order):

1. `?directory=<path>` query parameter
2. `x-opencode-directory` HTTP header
3. Falls back to `process.cwd()`

```bash
# Start server once
opencode serve --port 4096

# Access different projects
curl "http://localhost:4096/session?directory=/path/to/project-a"
curl "http://localhost:4096/session?directory=/path/to/project-b"
```

### SDK Usage

Nearly every SDK method accepts an optional `directory` parameter:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });

// Work with different projects from the same client
await client.session.list({ directory: "/path/to/project-a" });
await client.session.list({ directory: "/path/to/project-b" });
```

**Only 3 methods don't accept `directory`**: `global.health()`, `global.event()`, and `global.dispose()` - these are server-wide operations.

## Native Worktree Management

OpenCode provides built-in git worktree management via the `Worktree` namespace.

### Core Concepts

- **Worktree**: The primary git repository root (the "main" worktree)
- **Sandboxes**: Isolated git worktrees created for specific tasks, tracked in `Project.Info.sandboxes`

### SDK Methods

#### List Worktrees

```typescript
const result = await client.worktree.list({ directory: "/path/to/project" });
// Returns: string[] (list of sandbox worktree directories)
```

#### Create Worktree

```typescript
const result = await client.worktree.create({
  directory: "/path/to/project",
  worktreeCreateInput: {
    name: "my-feature", // Optional: custom name (auto-generated if omitted)
    startCommand: "bun install", // Optional: command to run after creation
  },
});
// Returns: { name: string, branch: string, directory: string }
```

### How It Works

1. **Name Generation**: Uses poetic names like `calm-forest` or `clever-eagle` (adjective-noun combinations)
2. **Branch Creation**: Creates a new branch under `opencode/<worktree-name>`
3. **Storage Location**: `$XDG_DATA_HOME/opencode/worktree/<project-id>/<worktree-name>/`
4. **Optional Initialization**: Runs a start command after creation

### Implementation Details

Located in `packages/opencode/src/worktree/index.ts`:

```typescript
// Core creation command
await $`git worktree add -b ${info.branch} ${info.directory}`.cwd(
  Instance.worktree,
);
```

### Error Types

- `WorktreeNotGitError` - Worktrees require a git repository
- `WorktreeNameGenerationFailedError` - Couldn't find a unique name
- `WorktreeCreateFailedError` - Git command failed
- `WorktreeStartCommandFailedError` - Init command failed

## Instance Context System

OpenCode uses `AsyncLocalStorage` to maintain per-request context:

- Contexts are cached by directory path
- First request to a directory lazily initializes it (project discovery, LSP, file watchers)
- Subsequent requests reuse the cached context
- Each directory maintains isolated state (sessions, config, worktrees)

### Accessing Context (Internal)

```typescript
Instance.directory; // Current working directory
Instance.worktree; // Git worktree (main repository root)
Instance.project; // Project info including sandboxes array
```

## API Endpoints

The worktree functionality is exposed under `/experimental/worktree`:

| Method | Endpoint                 | Description                |
| ------ | ------------------------ | -------------------------- |
| GET    | `/experimental/worktree` | List all sandbox worktrees |
| POST   | `/experimental/worktree` | Create a new worktree      |

## Limitations

- **No clone/create project**: Projects are implicitly created when you open a directory. There's no `project.create()` or `project.clone()` API.
- **Experimental API**: Worktree endpoints are under `/experimental/`, indicating the API may change.
- **Git required**: Worktrees only work with git repositories.

## Agent Integration Pattern

For agents that need isolated environments:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });

// 1. Create an isolated worktree for the task
const worktree = await client.worktree.create({
  directory: "/path/to/main/project",
  worktreeCreateInput: {
    name: "task-123",
    startCommand: "bun install",
  },
});

// 2. All subsequent operations use the worktree directory
await client.session.create({ directory: worktree.data.directory });
await client.session.prompt({
  directory: worktree.data.directory,
  sessionID: "...",
  // ...
});

// 3. When done, the worktree branch can be merged or discarded
```

This approach provides:

- Isolated git branch per task
- Separate working directory
- Independent session/state management
- Clean separation from main repository
