import { describe, test, expect } from "bun:test";
import { Result } from "better-result";
import { LinearUnknownError, OpencodeUnknownError } from "../src/errors";
import {
  IssueEventHandler,
  type IssueCleanupWebhookPayload,
} from "../src/IssueEventHandler";
import type { LinearService } from "../src/linear/LinearService";
import type { SessionRepository } from "../src/session/SessionRepository";
import type { SessionState } from "../src/session/SessionState";
import type { SessionCleanupResult } from "../src/session/WorktreeManager";

function createLinear(ids: string[]): LinearService {
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
    getIssueAgentSessionIds: async () => Result.ok(ids),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({ id: "s1", name: "Done", type: "completed" }),
  };
}

function createRepo(state: SessionState | null): SessionRepository {
  return {
    get: async (linearSessionId) => {
      if (!state || linearSessionId !== state.linearSessionId) {
        return null;
      }
      return state;
    },
    getByIssueId: async () => state,
    save: async () => undefined,
    delete: async () => undefined,
    getPendingQuestion: async () => null,
    savePendingQuestion: async () => undefined,
    deletePendingQuestion: async () => undefined,
    getPendingPermission: async () => null,
    savePendingPermission: async () => undefined,
    deletePendingPermission: async () => undefined,
    getPendingRepoSelection: async () => null,
    savePendingRepoSelection: async () => undefined,
    deletePendingRepoSelection: async () => undefined,
  };
}

function buildIssueEvent(stateType: string): IssueCleanupWebhookPayload {
  return {
    type: "Issue",
    action: "update",
    data: {
      id: "issue-1",
      identifier: "CODE-1",
      state: { type: stateType },
    },
  };
}

describe("IssueEventHandler", () => {
  test("cleans up linked sessions when issue completes", async () => {
    const state: SessionState = {
      linearSessionId: "session-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const aborts: Array<{ sessionID: string; directory: string }> = [];
    const cleanups: SessionState[] = [];
    const deletions: string[] = [];

    const repo = createRepo(state);
    const opencode = {
      abortSession: async (
        sessionID: string,
        directory: string,
      ): Promise<Result<void, never>> => {
        aborts.push({ sessionID, directory });
        return Result.ok(undefined);
      },
    };
    const worktree = {
      cleanupSessionResources: async (
        session: SessionState,
      ): Promise<SessionCleanupResult> => {
        cleanups.push(session);
        return {
          worktreeRemoved: true,
          branchRemoved: true,
          fullyCleaned: true,
        };
      },
    };
    const handler = new IssueEventHandler(
      createLinear(["session-1", "session-missing"]),
      opencode,
      {
        ...repo,
        delete: async (linearSessionId: string): Promise<void> => {
          deletions.push(linearSessionId);
        },
      },
      worktree,
    );

    await handler.process(buildIssueEvent("completed"));

    expect(aborts).toEqual([
      { sessionID: "opencode-1", directory: "/tmp/worktree-1" },
    ]);
    expect(cleanups).toEqual([state]);
    expect(deletions).toEqual(["session-1"]);
  });

  test("preserves session state when cleanup is incomplete", async () => {
    const state: SessionState = {
      linearSessionId: "session-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const deletions: string[] = [];

    const handler = new IssueEventHandler(
      createLinear(["session-1"]),
      {
        abortSession: async (): Promise<Result<void, never>> =>
          Result.ok(undefined),
      },
      {
        ...createRepo(state),
        delete: async (linearSessionId: string): Promise<void> => {
          deletions.push(linearSessionId);
        },
      },
      {
        cleanupSessionResources: async (): Promise<SessionCleanupResult> => ({
          worktreeRemoved: true,
          branchRemoved: false,
          fullyCleaned: false,
        }),
      },
    );

    await handler.process(buildIssueEvent("completed"));

    expect(deletions).toEqual([]);
  });

  test("ignores issue updates outside completed/canceled", async () => {
    const aborts: string[] = [];
    const handler = new IssueEventHandler(
      createLinear(["session-1"]),
      {
        abortSession: async (): Promise<Result<void, never>> => {
          aborts.push("called");
          return Result.ok(undefined);
        },
      },
      createRepo(null),
      {
        cleanupSessionResources: async (): Promise<SessionCleanupResult> => ({
          worktreeRemoved: true,
          branchRemoved: true,
          fullyCleaned: true,
        }),
      },
    );

    await handler.process(buildIssueEvent("started"));
    expect(aborts).toHaveLength(0);
  });

  test("ignores non-update actions", async () => {
    const aborts: string[] = [];
    const handler = new IssueEventHandler(
      createLinear(["session-1"]),
      {
        abortSession: async (): Promise<Result<void, never>> => {
          aborts.push("called");
          return Result.ok(undefined);
        },
      },
      createRepo(null),
      {
        cleanupSessionResources: async (): Promise<SessionCleanupResult> => ({
          worktreeRemoved: true,
          branchRemoved: true,
          fullyCleaned: true,
        }),
      },
    );

    const event = buildIssueEvent("completed");
    event.action = "create";

    await handler.process(event);
    expect(aborts).toHaveLength(0);
  });

  test("retries issue session lookup before cleanup", async () => {
    const state: SessionState = {
      linearSessionId: "session-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const lookups: string[] = [];
    const cleanups: string[] = [];

    const linear: LinearService = {
      ...createLinear(["session-1"]),
      getIssueAgentSessionIds: async () => {
        lookups.push("call");
        if (lookups.length < 2) {
          return Result.err(new LinearUnknownError({ reason: "transient" }));
        }
        return Result.ok(["session-1"]);
      },
    };

    const handler = new IssueEventHandler(
      linear,
      {
        abortSession: async (): Promise<Result<void, never>> =>
          Result.ok(undefined),
      },
      {
        ...createRepo(state),
        delete: async (): Promise<void> => undefined,
      },
      {
        cleanupSessionResources: async (
          session: SessionState,
        ): Promise<SessionCleanupResult> => {
          cleanups.push(session.linearSessionId);
          return {
            worktreeRemoved: true,
            branchRemoved: true,
            fullyCleaned: true,
          };
        },
      },
    );

    Object.defineProperty(handler, "wait", {
      value: async (): Promise<void> => undefined,
    });

    await handler.process(buildIssueEvent("completed"));

    expect(lookups).toHaveLength(2);
    expect(cleanups).toEqual(["session-1"]);
  });

  test("preserves session state when abort fails", async () => {
    const state: SessionState = {
      linearSessionId: "session-1",
      opencodeSessionId: "opencode-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const deletions: string[] = [];
    const handler = new IssueEventHandler(
      createLinear(["session-1"]),
      {
        abortSession: async (): Promise<Result<void, OpencodeUnknownError>> =>
          Result.err(new OpencodeUnknownError({ reason: "timeout" })),
      },
      {
        ...createRepo(state),
        delete: async (linearSessionId: string): Promise<void> => {
          deletions.push(linearSessionId);
        },
      },
      {
        cleanupSessionResources: async (): Promise<SessionCleanupResult> => ({
          worktreeRemoved: true,
          branchRemoved: true,
          fullyCleaned: true,
        }),
      },
    );

    await handler.process(buildIssueEvent("completed"));

    expect(deletions).toEqual([]);
  });
});
