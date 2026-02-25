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
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({ id: "state-1", name: "Started", type: "started" }),
  };
}

function createRepository(): SessionRepository {
  return {
    get: async (): Promise<SessionState | null> => null,
    save: async (): Promise<void> => undefined,
    delete: async (): Promise<void> => undefined,
    getPendingQuestion: async (): Promise<PendingQuestion | null> => null,
    savePendingQuestion: async (): Promise<void> => undefined,
    deletePendingQuestion: async (): Promise<void> => undefined,
    getPendingPermission: async (): Promise<PendingPermission | null> => null,
    savePendingPermission: async (): Promise<void> => undefined,
    deletePendingPermission: async (): Promise<void> => undefined,
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
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const result = await manager.cleanupSessionResources(state, createLogger());

    expect(calls).toHaveLength(0);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchRemoved).toBe(false);
    expect(result.fullyCleaned).toBe(false);
  });
});
