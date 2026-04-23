import { Result } from "better-result";
import { describe, test, expect } from "bun:test";

import type { SessionState } from "../../src/state/schema";

import { KvIoError, KvNotFoundError } from "../../src/kv/errors";
import { IssueEventHandler } from "../../src/linear-event-processor/IssueEventHandler";
import { OpencodeUnknownError } from "../../src/opencode-service/errors";
import { saveSessionState } from "../../src/state/session-state";
import { TestLinearService } from "../linear-service/TestLinearService";
import { FailingKeyValueStore } from "../state/FailingKeyValueStore";
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

async function createAgentState(state?: SessionState) {
  const agentState = createInMemoryAgentState();
  if (state) {
    await saveSessionState(agentState, state);
  }
  await agentState.issueWorkspace.put("issue-1", {
    projectId: "project-1",
    projectDirectory: "/repos/opencode-linear-agent",
    workspaceId: "workspace-1",
    workspaceDirectory: "/tmp/workspace-1",
    branchName: "feature/code-1",
  });
  return agentState;
}

async function createFailingAgentState(state?: SessionState): Promise<{
  agentState: ReturnType<typeof createInMemoryAgentState>;
  sessionStore: FailingKeyValueStore<SessionState>;
}> {
  const agentState = createInMemoryAgentState();
  const sessionStore = new FailingKeyValueStore(agentState.session);
  const failingState = {
    ...agentState,
    session: sessionStore,
  };
  if (state) {
    await saveSessionState(failingState, state);
  }
  await failingState.issueWorkspace.put("issue-1", {
    projectId: "project-1",
    projectDirectory: "/repos/opencode-linear-agent",
    workspaceId: "workspace-1",
    workspaceDirectory: "/tmp/workspace-1",
    branchName: "feature/code-1",
  });
  return { agentState: failingState, sessionStore };
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
  test("removes workspace and session state when cleanup succeeds", async () => {
    const state = createSessionState();
    const agentState = await createAgentState(state);
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
        removeWorkspace: async (workspaceId: string) => {
          removes.push(workspaceId);
          return Promise.resolve(Result.ok(undefined));
        },
      },
      agentState,
    );

    await handler.process(createEvent("completed"));

    expect(aborts).toEqual([{ sessionID: "opencode-1", directory: "/tmp/worktree-1" }]);
    expect(removes).toEqual(["workspace-1"]);
    expect(await agentState.session.get("session-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "session-1" })),
    );
    expect(await agentState.issueWorkspace.get("issue-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "issue-1" })),
    );
  });

  test("preserves workspace state when workspace removal fails", async () => {
    const state = createSessionState();
    const agentState = await createAgentState(state);
    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1"])),
      }),
      {
        abortSession: async () => Promise.resolve(Result.ok(undefined)),
        removeWorkspace: async () =>
          Promise.resolve(Result.err(new OpencodeUnknownError({ reason: "busy" }))),
      },
      agentState,
    );

    await handler.process(createEvent("completed"));

    expect(await agentState.session.get("session-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "session-1" })),
    );
    expect(await agentState.issueWorkspace.get("issue-1")).toEqual(
      Result.ok({
        projectId: "project-1",
        projectDirectory: "/repos/opencode-linear-agent",
        workspaceId: "workspace-1",
        workspaceDirectory: "/tmp/workspace-1",
        branchName: "feature/code-1",
      }),
    );
  });

  test("throws when session state load fails during cleanup", async () => {
    const state = createSessionState();
    const { agentState, sessionStore } = await createFailingAgentState(state);
    const err = new KvIoError({ path: "session", operation: "get", reason: "disk full" });
    sessionStore.failOnce("get", err);

    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1"])),
      }),
      {
        abortSession: async () => Promise.resolve(Result.ok(undefined)),
        removeWorkspace: async () => Promise.resolve(Result.ok(undefined)),
      },
      agentState,
    );

    const caught = await handler.process(createEvent("completed")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toEqual(err);
    expect(await agentState.session.get("session-1")).toEqual(Result.ok(state));
  });

  test("throws when session state delete fails after cleanup", async () => {
    const state = createSessionState();
    const { agentState, sessionStore } = await createFailingAgentState(state);
    const err = new KvIoError({ path: "session", operation: "delete", reason: "disk full" });
    sessionStore.failOnce("delete", err);

    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1"])),
      }),
      {
        abortSession: async () => Promise.resolve(Result.ok(undefined)),
        removeWorkspace: async () => Promise.resolve(Result.ok(undefined)),
      },
      agentState,
    );

    const caught = await handler.process(createEvent("completed")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toEqual(err);
    expect(await agentState.session.get("session-1")).toEqual(Result.ok(state));
  });

  test("removes shared workspace once after cleaning multiple sessions", async () => {
    const agentState = await createAgentState(createSessionState());
    await saveSessionState(agentState, {
      ...createSessionState(),
      linearSessionId: "session-2",
      opencodeSessionId: "opencode-2",
      workdir: "/tmp/worktree-1",
    });

    const removes: string[] = [];
    const handler = new IssueEventHandler(
      new TestLinearService({
        getIssueAgentSessionIds: async () => Promise.resolve(Result.ok(["session-1", "session-2"])),
      }),
      {
        abortSession: async () => Promise.resolve(Result.ok(undefined)),
        removeWorkspace: async (workspaceId: string) => {
          removes.push(workspaceId);
          return Promise.resolve(Result.ok(undefined));
        },
      },
      agentState,
    );

    await handler.process(createEvent("completed"));

    expect(removes).toEqual(["workspace-1"]);
  });

  test("ignores issue states outside completed and canceled", async () => {
    const agentState = await createAgentState();
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
        removeWorkspace: async () => {
          calls.push("remove");
          return Promise.resolve(Result.ok(undefined));
        },
      },
      agentState,
    );

    await handler.process(createEvent("started"));

    expect(calls).toEqual([]);
  });
});
