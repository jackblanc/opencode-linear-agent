import { Result } from "better-result";
import { describe, test, expect } from "bun:test";

import type { SessionState } from "../../src/state/schema";

import { KvNotFoundError } from "../../src/kv/errors";
import { IssueEventHandler } from "../../src/linear-event-processor/IssueEventHandler";
import { OpencodeUnknownError } from "../../src/opencode-service/errors";
import { SessionRepository } from "../../src/state/SessionRepository";
import { TestLinearService } from "../linear-service/TestLinearService";
import { createInMemoryAgentState } from "../state/InMemoryAgentNamespace";

function createSessionState(): SessionState {
  return {
    linearSessionId: "session-1",
    opencodeSessionId: "opencode-1",
    organizationId: "org-1",
    issueId: "issue-1",
    projectId: "project-1",
    branchName: "feature/code-1",
    workdir: "/tmp/worktree-1",
    lastActivityTime: Date.now(),
  };
}

async function createRepository(state?: SessionState): Promise<SessionRepository> {
  const repository = new SessionRepository(createInMemoryAgentState());
  if (state) {
    await repository.save(state);
  }
  return repository;
}

function createEvent(stateType: string) {
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
  test("removes worktree and session state when cleanup succeeds", async () => {
    const state = createSessionState();
    const repository = await createRepository(state);
    const aborts: Array<{ sessionID: string; directory: string }> = [];
    const removes: string[] = [];
    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1"])),
      }),
      {
        abortSession: async (sessionID: string, directory: string) => {
          aborts.push({ sessionID, directory });
          return Promise.resolve(Result.ok(undefined));
        },
        removeWorktree: async (directory: string) => {
          removes.push(directory);
          return Promise.resolve(Result.ok(undefined));
        },
      },
      repository,
    );

    await handler.process(createEvent("completed"));

    expect(aborts).toEqual([{ sessionID: "opencode-1", directory: "/tmp/worktree-1" }]);
    expect(removes).toEqual(["/tmp/worktree-1"]);
    expect(await repository.get("session-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "session-1" })),
    );
  });

  test("preserves state when worktree removal fails", async () => {
    const state = createSessionState();
    const repository = await createRepository(state);
    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1"])),
      }),
      {
        abortSession: async () => Promise.resolve(Result.ok(undefined)),
        removeWorktree: async () =>
          Promise.resolve(Result.err(new OpencodeUnknownError({ reason: "busy" }))),
      },
      repository,
    );

    await handler.process(createEvent("completed"));

    expect(await repository.get("session-1")).toEqual(Result.ok(state));
  });

  test("ignores issue states outside completed and canceled", async () => {
    const repository = await createRepository();
    const calls: string[] = [];
    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1"])),
      }),
      {
        abortSession: async () => {
          calls.push("abort");
          return Promise.resolve(Result.ok(undefined));
        },
        removeWorktree: async () => {
          calls.push("remove");
          return Promise.resolve(Result.ok(undefined));
        },
      },
      repository,
    );

    await handler.process(createEvent("started"));

    expect(calls).toEqual([]);
  });
});
