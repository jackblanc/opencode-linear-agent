import { describe, test, expect } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { OpencodeService } from "../../src/opencode-service/OpencodeService";
import type { LinearService } from "../../src";
import { SessionRepository } from "../../src/state/SessionRepository";
import type { SessionState } from "../../src/state/schema";
import { WorktreeManager } from "../../src/session/WorktreeManager";
import type { Logger } from "../../src/utils/logger";
import { TestLinearService } from "../linear-service/TestLinearService";
import { createInMemoryAgentState } from "../state/InMemoryAgentNamespace";

function createLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    tag: () => logger,
    time: () => () => undefined,
  };
  return logger;
}

function createLinearService(): LinearService {
  return new TestLinearService();
}

function createRepository(): SessionRepository {
  return new SessionRepository(createInMemoryAgentState());
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
      organizationId: "org-1",
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
      organizationId: "org-1",
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
    const agentState = createInMemoryAgentState();
    const repository = new SessionRepository(agentState);
    const state: SessionState = {
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      branchName: "feature/code-1",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    await repository.save(state);

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
      "prompted",
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
    expect(await repository.get("linear-1")).toEqual({
      ...state,
      repoDirectory: "/tmp/default",
    });
    expect(createCalls).toHaveLength(0);
  });

  test("reuses existing state for retried created events", async () => {
    const agentState = createInMemoryAgentState();
    const repository = new SessionRepository(agentState);
    const state: SessionState = {
      linearSessionId: "linear-2",
      opencodeSessionId: "opencode-2",
      organizationId: "org-1",
      issueId: "issue-2",
      repoDirectory: "/tmp/default",
      branchName: "feature/code-2",
      workdir: "/tmp",
      lastActivityTime: Date.now(),
    };

    const creates: string[] = [];
    await repository.save(state);

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
      "created",
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

    const result = await manager.resolveWorktree(
      "123e4567-e89b-12d3-a456-426614174000",
      {
        identifier: "CODE-3",
        branchName: "jack/code-3-linear-branch",
      },
      "created",
      createLogger(),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(names).toEqual(["123e4567-jack/code-3-linear-branch"]);
  });
});
