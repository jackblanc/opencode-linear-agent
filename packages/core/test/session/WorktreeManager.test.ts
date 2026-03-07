import { describe, test, expect } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { OpencodeService } from "../../src/opencode/OpencodeService";
import type { LinearService } from "../../src/linear/LinearService";
import type {
  PendingPermission,
  PendingQuestion,
  SessionRepository,
} from "../../src/session/SessionRepository";
import type { SessionState } from "../../src/session/SessionState";
import { WorktreeManager } from "../../src/session/WorktreeManager";
import type { Logger } from "../../src/logger";

function createLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    tag: () => logger,
    clone: () => logger,
  };
  return logger;
}

function createLinearService(): LinearService {
  return {
    postActivity: async () => Result.ok(undefined),
    postStageActivity: async () => Result.ok(undefined),
    postError: async () => Result.ok(undefined),
    postElicitation: async () => Result.ok(undefined),
    setExternalLink: async () => Result.ok(undefined),
    updatePlan: async () => Result.ok(undefined),
    getIssue: async () =>
      Result.ok({
        id: "issue-1",
        identifier: "CODE-1",
        title: "x",
        url: "https://linear.app",
      }),
    getIssueLabels: async () => Result.ok([]),
    getIssueAttachments: async () => Result.ok([]),
    getIssueRepositorySuggestions: async () => Result.ok([]),
    setIssueRepoLabel: async () => Result.ok(undefined),
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({ id: "state-1", name: "Started", type: "started" }),
  };
}

function createRepository(): SessionRepository {
  return {
    get: async (): Promise<SessionState | null> => null,
    getByIssueId: async (): Promise<SessionState | null> => null,
    save: async (): Promise<void> => undefined,
    delete: async (): Promise<void> => undefined,
    getPendingQuestion: async (): Promise<PendingQuestion | null> => null,
    savePendingQuestion: async (): Promise<void> => undefined,
    deletePendingQuestion: async (): Promise<void> => undefined,
    getPendingPermission: async (): Promise<PendingPermission | null> => null,
    savePendingPermission: async (): Promise<void> => undefined,
    deletePendingPermission: async (): Promise<void> => undefined,
    getPendingRepoSelection: async (): Promise<null> => null,
    savePendingRepoSelection: async (): Promise<void> => undefined,
    deletePendingRepoSelection: async (): Promise<void> => undefined,
  };
}

describe("WorktreeManager.cleanupSessionResources", () => {
  test("does not report fully cleaned when branch verification fails", async () => {
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      createRepository(),
      "/tmp/default",
    );

    Object.defineProperty(manager, "runGit", {
      value: async () => Result.err(new Error("not a git repository")),
    });

    const state: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/missing-worktree",
      lastActivityTime: Date.now(),
    };

    const result = await manager.cleanupSessionResources(state, createLogger());

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchRemoved).toBe(false);
    expect(result.fullyCleaned).toBe(false);
  });

  test("skips cleanup and preserves state for legacy sessions without repo", async () => {
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      createRepository(),
      "/tmp/default",
    );

    const calls: string[][] = [];
    Object.defineProperty(manager, "runGit", {
      value: async (_repoDirectory: string, args: string[]) => {
        calls.push(args);
        return Result.ok(undefined);
      },
    });

    const state: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      branchName: "feature/code-1",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    const result = await manager.cleanupSessionResources(state, createLogger());

    expect(calls).toHaveLength(0);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchRemoved).toBe(false);
    expect(result.fullyCleaned).toBe(false);
  });
});

describe("WorktreeManager.resolveWorktree", () => {
  test("migrates legacy sessions without repoDirectory", async () => {
    const state: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      branchName: "feature/code-1",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    const deletes: string[] = [];
    const saves: SessionState[] = [];
    const repository: SessionRepository = {
      get: async (): Promise<SessionState | null> => state,
      getByIssueId: async (): Promise<SessionState | null> => null,
      save: async (next: SessionState): Promise<void> => {
        saves.push(next);
      },
      delete: async (linearSessionId: string): Promise<void> => {
        deletes.push(linearSessionId);
      },
      getPendingQuestion: async (): Promise<PendingQuestion | null> => null,
      savePendingQuestion: async (): Promise<void> => undefined,
      deletePendingQuestion: async (): Promise<void> => undefined,
      getPendingPermission: async (): Promise<PendingPermission | null> => null,
      savePendingPermission: async (): Promise<void> => undefined,
      deletePendingPermission: async (): Promise<void> => undefined,
      getPendingRepoSelection: async (): Promise<null> => null,
      savePendingRepoSelection: async (): Promise<void> => undefined,
      deletePendingRepoSelection: async (): Promise<void> => undefined,
    };

    const createCalls: string[] = [];
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async () => {
        createCalls.push("called");
        return Result.ok({
          directory: "/tmp/new-worktree",
          branch: "feature/new",
        });
      },
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      repository,
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async () => Result.ok(undefined),
    });

    const result = await manager.resolveWorktree(
      "linear-1",
      { identifier: "CODE-1" },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toEqual({
      workdir: "/tmp",
      branchName: "feature/code-1",
      source: "existing_session",
    });
    expect(deletes).toHaveLength(0);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.repoDirectory).toBe("/tmp/default");
    expect(createCalls).toHaveLength(0);
  });

  test("reuses existing state for retried created events", async () => {
    const state: SessionState = {
      linearSessionId: "linear-2",
      opencodeSessionId: "opencode-2",
      issueId: "issue-2",
      repoDirectory: "/tmp/default",
      branchName: "feature/code-2",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    const creates: string[] = [];
    const repository: SessionRepository = {
      get: async (): Promise<SessionState | null> => state,
      getByIssueId: async (): Promise<SessionState | null> => null,
      save: async (): Promise<void> => undefined,
      delete: async (): Promise<void> => undefined,
      getPendingQuestion: async (): Promise<PendingQuestion | null> => null,
      savePendingQuestion: async (): Promise<void> => undefined,
      deletePendingQuestion: async (): Promise<void> => undefined,
      getPendingPermission: async (): Promise<PendingPermission | null> => null,
      savePendingPermission: async (): Promise<void> => undefined,
      deletePendingPermission: async (): Promise<void> => undefined,
      getPendingRepoSelection: async (): Promise<null> => null,
      savePendingRepoSelection: async (): Promise<void> => undefined,
      deletePendingRepoSelection: async (): Promise<void> => undefined,
    };

    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async () => {
        creates.push("called");
        return Result.ok({
          directory: "/tmp/new-worktree",
          branch: "feature/new",
        });
      },
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      repository,
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async () => Result.ok(undefined),
    });

    const result = await manager.resolveWorktree(
      "linear-2",
      { identifier: "CODE-2" },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toEqual({
      workdir: "/tmp",
      branchName: "feature/code-2",
      source: "existing_session",
    });
    expect(creates).toHaveLength(0);
  });

  test("uses Linear branch suggestion for new worktrees", async () => {
    const names: string[] = [];
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async (
        _directory: string,
        name: string,
      ): Promise<Result<{ directory: string; branch: string }, never>> => {
        names.push(name);
        return Result.ok({
          directory: "/tmp/new-worktree",
          branch: `opencode/${name}`,
        });
      },
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      createRepository(),
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async () => Result.ok(undefined),
    });

    const result = await manager.resolveWorktree(
      "123e4567-e89b-12d3-a456-426614174000",
      {
        identifier: "CODE-3",
        branchName: "jack/code-3-linear-branch",
      },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(names).toEqual(["jack/code-3-linear-branch"]);
  });

  test("reuses issue worktree across Linear sessions", async () => {
    const state: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-1",
      issueId: "CODE-4",
      repoDirectory: "/tmp/default",
      branchName: "jack/code-4-linear-branch",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    const names: string[] = [];
    const issueIds: string[] = [];
    const repository: SessionRepository = {
      get: async (): Promise<SessionState | null> => null,
      getByIssueId: async (issueId: string): Promise<SessionState | null> => {
        issueIds.push(issueId);
        return issueId === "issue-4" ? state : null;
      },
      save: async (): Promise<void> => undefined,
      delete: async (): Promise<void> => undefined,
      getPendingQuestion: async (): Promise<PendingQuestion | null> => null,
      savePendingQuestion: async (): Promise<void> => undefined,
      deletePendingQuestion: async (): Promise<void> => undefined,
      getPendingPermission: async (): Promise<PendingPermission | null> => null,
      savePendingPermission: async (): Promise<void> => undefined,
      deletePendingPermission: async (): Promise<void> => undefined,
      getPendingRepoSelection: async (): Promise<null> => null,
      savePendingRepoSelection: async (): Promise<void> => undefined,
      deletePendingRepoSelection: async (): Promise<void> => undefined,
    };

    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async () => {
        names.push("called");
        return Result.ok({
          directory: "/tmp/new-worktree",
          branch: "feature/new",
        });
      },
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      repository,
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async () => Result.ok(undefined),
    });

    const result = await manager.resolveWorktree(
      "linear-2",
      {
        id: "issue-4",
        identifier: "CODE-4",
        branchName: "jack/code-4-linear-branch",
      },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toEqual({
      workdir: "/tmp",
      branchName: "jack/code-4-linear-branch",
      source: "existing_issue",
    });
    expect(issueIds).toEqual(["issue-4"]);
    expect(names).toHaveLength(0);
  });

  test("skips inconclusive issue worktree reuse and creates fresh worktree", async () => {
    const state: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-6",
      repoDirectory: "/tmp/default",
      branchName: "jack/code-6-linear-branch",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    const creates: string[] = [];
    const repository: SessionRepository = {
      get: async (): Promise<SessionState | null> => null,
      getByIssueId: async (): Promise<SessionState | null> => state,
      save: async (): Promise<void> => undefined,
      delete: async (): Promise<void> => undefined,
      getPendingQuestion: async (): Promise<PendingQuestion | null> => null,
      savePendingQuestion: async (): Promise<void> => undefined,
      deletePendingQuestion: async (): Promise<void> => undefined,
      getPendingPermission: async (): Promise<PendingPermission | null> => null,
      savePendingPermission: async (): Promise<void> => undefined,
      deletePendingPermission: async (): Promise<void> => undefined,
      getPendingRepoSelection: async (): Promise<null> => null,
      savePendingRepoSelection: async (): Promise<void> => undefined,
      deletePendingRepoSelection: async (): Promise<void> => undefined,
    };

    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async () => {
        creates.push("called");
        return Result.ok({
          directory: "/tmp/new-worktree",
          branch: "jack/code-6-linear-branch",
        });
      },
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      repository,
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async (_repoDirectory: string, args: string[]) => {
        if (args[0] === "show-ref") {
          return Result.err(new Error("git unavailable"));
        }
        return Result.ok(undefined);
      },
    });

    const result = await manager.resolveWorktree(
      "linear-2",
      {
        id: "issue-6",
        identifier: "CODE-6",
        branchName: "jack/code-6-linear-branch",
      },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.source).toBe("created");
    expect(creates).toHaveLength(1);
  });

  test("renames created branch to requested issue branch", async () => {
    const gitCalls: string[][] = [];
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async () =>
        Result.ok({
          directory: "/tmp/new-worktree",
          branch: "opencode/jack/code-5-linear-branch",
        }),
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      createRepository(),
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async (_repoDirectory: string, args: string[]) => {
        gitCalls.push(args);
        return Result.ok(undefined);
      },
    });

    const result = await manager.resolveWorktree(
      "linear-session-1",
      {
        identifier: "CODE-5",
        branchName: "jack/code-5-linear-branch",
      },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.branchName).toBe("jack/code-5-linear-branch");
    expect(gitCalls).toEqual([["branch", "-m", "jack/code-5-linear-branch"]]);
  });

  test("keeps created branch name when target branch already exists", async () => {
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );
    Object.defineProperty(opencode, "createWorktree", {
      value: async () =>
        Result.ok({
          directory: "/tmp/new-worktree",
          branch: "opencode/jack/code-7-linear-branch",
        }),
    });

    const manager = new WorktreeManager(
      opencode,
      createLinearService(),
      createRepository(),
      "/tmp/default",
    );
    Object.defineProperty(manager, "runGit", {
      value: async (_repoDirectory: string, args: string[]) => {
        if (args[0] === "branch") {
          return Result.err(new Error("branch already exists"));
        }
        if (args[0] === "show-ref") {
          return Result.ok(undefined);
        }
        return Result.err(new Error("unexpected"));
      },
    });

    const result = await manager.resolveWorktree(
      "linear-session-1",
      {
        identifier: "CODE-7",
        branchName: "jack/code-7-linear-branch",
      },
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.branchName).toBe("opencode/jack/code-7-linear-branch");
  });
});
