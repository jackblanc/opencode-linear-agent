import { describe, test, expect } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { OpencodeUnknownError } from "../../src/errors";
import { OpencodeService } from "../../src/opencode/OpencodeService";
import { SessionManager } from "../../src/session/SessionManager";
import type {
  PendingPermission,
  PendingQuestion,
  SessionRepository,
} from "../../src/session/SessionRepository";
import type { SessionState } from "../../src/session/SessionState";

function createRepository(state: SessionState): {
  repository: SessionRepository;
  saves: SessionState[];
  deletes: string[];
} {
  const saves: SessionState[] = [];
  const deletes: string[] = [];

  return {
    repository: {
      get: async (): Promise<SessionState | null> => state,
      getByIssueId: async (): Promise<SessionState | null> => state,
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
    },
    saves,
    deletes,
  };
}

describe("SessionManager", () => {
  test("keeps stored repoDirectory when recreating existing session", async () => {
    const existing: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-old",
      issueId: "issue-1",
      repoDirectory: "/tmp/original-repo",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const { repository, saves } = createRepository(existing);
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );

    Object.defineProperty(opencode, "getSession", {
      value: async () =>
        Result.err(new OpencodeUnknownError({ reason: "missing" })),
    });

    Object.defineProperty(opencode, "getMessages", {
      value: async () => Result.ok([]),
    });

    Object.defineProperty(opencode, "createSession", {
      value: async () => Result.ok({ id: "opencode-new" }),
    });

    const manager = new SessionManager(opencode, repository);
    const result = await manager.getOrCreateSession(
      "linear-1",
      "issue-1",
      "/tmp/new-repo-from-dispatcher",
      "feature/code-1",
      "/tmp/worktree-1",
    );

    expect(Result.isOk(result)).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.repoDirectory).toBe("/tmp/original-repo");
  });
});
