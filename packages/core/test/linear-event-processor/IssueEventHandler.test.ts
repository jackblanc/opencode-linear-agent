import { describe, test, expect } from "bun:test";
import { Result } from "better-result";
import { LinearUnknownError } from "../../src/linear-service/errors";
import { OpencodeUnknownError } from "../../src/opencode-service/errors";
import { IssueEventHandler } from "../../src/linear-event-processor/IssueEventHandler";
import type { LinearService } from "../../src/linear-service/LinearService";
import { SessionRepository } from "../../src/state/SessionRepository";
import type { SessionState } from "../../src/state/schema";
import { TestLinearService } from "../linear-service/TestLinearService";
import { createInMemoryAgentState } from "../state/InMemoryAgentNamespace";

function createLinear(ids: string[]): LinearService {
  return new TestLinearService({
    getIssueAgentSessionIds: async () => Result.ok(ids),
    getIssueState: async () =>
      Result.ok({ id: "s1", name: "Done", type: "completed" }),
  });
}

async function createRepo(state: SessionState | null): Promise<{
  agentState: ReturnType<typeof createInMemoryAgentState>;
  repository: SessionRepository;
}> {
  const agentState = createInMemoryAgentState();
  const repository = new SessionRepository(agentState);
  if (state) {
    await repository.save(state);
  }
  return { agentState, repository };
}

function buildIssueEvent(stateType: string) {
  return {
    type: "Issue" as const,
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
      organizationId: "org-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const aborts: Array<{ sessionID: string; directory: string }> = [];
    const cleanups: SessionState[] = [];
    const { repository } = await createRepo(state);
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
      cleanupSessionResources: async (session: SessionState) => {
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
      repository,
      worktree,
    );

    await handler.process(buildIssueEvent("completed"));

    expect(aborts).toEqual([
      { sessionID: "opencode-1", directory: "/tmp/worktree-1" },
    ]);
    expect(cleanups).toEqual([state]);
    expect(await repository.get("session-1")).toBeNull();
  });

  test("preserves session state when cleanup is incomplete", async () => {
    const state: SessionState = {
      linearSessionId: "session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const { repository } = await createRepo(state);

    const handler = new IssueEventHandler(
      createLinear(["session-1"]),
      {
        abortSession: async (): Promise<Result<void, never>> =>
          Result.ok(undefined),
      },
      repository,
      {
        cleanupSessionResources: async () => ({
          worktreeRemoved: true,
          branchRemoved: false,
          fullyCleaned: false,
        }),
      },
    );

    await handler.process(buildIssueEvent("completed"));

    expect(await repository.get("session-1")).toEqual(state);
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
      (await createRepo(null)).repository,
      {
        cleanupSessionResources: async () => ({
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
      (await createRepo(null)).repository,
      {
        cleanupSessionResources: async () => ({
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
      organizationId: "org-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const lookups: string[] = [];
    const cleanups: string[] = [];

    const linear = new TestLinearService({
      getIssueAgentSessionIds: async () => {
        lookups.push("call");
        if (lookups.length < 2) {
          return Result.err(new LinearUnknownError({ reason: "transient" }));
        }
        return Result.ok(["session-1"]);
      },
    });

    const { repository } = await createRepo(state);

    const handler = new IssueEventHandler(
      linear,
      {
        abortSession: async (): Promise<Result<void, never>> =>
          Result.ok(undefined),
      },
      repository,
      {
        cleanupSessionResources: async (session: SessionState) => {
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
      organizationId: "org-1",
      issueId: "issue-1",
      repoDirectory: "/tmp/repo-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: Date.now(),
    };

    const { repository } = await createRepo(state);
    const handler = new IssueEventHandler(
      createLinear(["session-1"]),
      {
        abortSession: async (): Promise<Result<void, OpencodeUnknownError>> =>
          Result.err(new OpencodeUnknownError({ reason: "timeout" })),
      },
      repository,
      {
        cleanupSessionResources: async () => ({
          worktreeRemoved: true,
          branchRemoved: true,
          fullyCleaned: true,
        }),
      },
    );

    await handler.process(buildIssueEvent("completed"));

    expect(await repository.get("session-1")).toEqual(state);
  });
});
