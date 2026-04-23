import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { PendingPermission, PendingQuestion, SessionState } from "../../src/state/schema";

import { KvIoError, KvNotFoundError } from "../../src/kv/errors";
import { sessionByOpencodeRecordSchema } from "../../src/state/schema";
import { deleteSessionState, saveSessionState } from "../../src/state/session-state";
import { FailingKeyValueStore } from "./FailingKeyValueStore";
import { createInMemoryAgentState } from "./InMemoryAgentNamespace";
import { MemoryKeyValueStore } from "./MemoryKeyValueStore";

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    linearSessionId: "linear-1",
    opencodeSessionId: "opencode-1",
    organizationId: "org-1",
    issueId: "issue-1",
    projectId: "project-1",
    branchName: "feature/code-1",
    workdir: "/tmp/worktree",
    lastActivityTime: Date.now(),
    ...overrides,
  };
}

describe("session-state helpers", () => {
  test("saves canonical session and opencode index", async () => {
    const agentState = createInMemoryAgentState();
    const state = createSessionState();

    await saveSessionState(agentState, state);

    expect(await agentState.session.get("linear-1")).toEqual(Result.ok(state));
    expect(await agentState.sessionByOpencode.get("opencode-1")).toEqual(
      Result.ok({ linearSessionId: "linear-1" }),
    );
  });

  test("updates opencode index when session id changes", async () => {
    const agentState = createInMemoryAgentState();

    await saveSessionState(agentState, createSessionState());
    await saveSessionState(agentState, createSessionState({ opencodeSessionId: "opencode-2" }));

    expect(await agentState.sessionByOpencode.get("opencode-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "opencode-1" })),
    );
    expect(await agentState.sessionByOpencode.get("opencode-2")).toEqual(
      Result.ok({ linearSessionId: "linear-1" }),
    );
  });

  test("deletes session index and pending records on cleanup", async () => {
    const agentState = createInMemoryAgentState();
    const question: PendingQuestion = {
      requestId: "q-1",
      opencodeSessionId: "opencode-1",
      linearSessionId: "linear-1",
      workdir: "/tmp/worktree",
      issueId: "issue-1",
      questions: [],
      answers: [],
      createdAt: Date.now(),
    };
    const permission: PendingPermission = {
      requestId: "p-1",
      opencodeSessionId: "opencode-1",
      linearSessionId: "linear-1",
      workdir: "/tmp/worktree",
      issueId: "issue-1",
      permission: "Edit",
      patterns: ["*.ts"],
      metadata: {},
      createdAt: Date.now(),
    };

    await saveSessionState(agentState, createSessionState());
    await agentState.question.put("linear-1", question);
    await agentState.permission.put("linear-1", permission);
    await agentState.repoSelection.put("linear-1", {
      linearSessionId: "linear-1",
      issueId: "issue-1",
      options: [],
      createdAt: Date.now(),
    });

    await deleteSessionState(agentState, "linear-1");

    expect(await agentState.session.get("linear-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "linear-1" })),
    );
    expect(await agentState.sessionByOpencode.get("opencode-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "opencode-1" })),
    );
    expect(await agentState.question.get("linear-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "linear-1" })),
    );
    expect(await agentState.permission.get("linear-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "linear-1" })),
    );
    expect(await agentState.repoSelection.get("linear-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "linear-1" })),
    );
  });

  test("rolls back fresh save when index put fails", async () => {
    const agentState = createInMemoryAgentState();
    const failingIndex = new FailingKeyValueStore(
      new MemoryKeyValueStore(sessionByOpencodeRecordSchema),
    );
    const state = {
      ...agentState,
      sessionByOpencode: failingIndex,
    };

    failingIndex.failOnce(
      "put",
      new KvIoError({ path: "index", operation: "put", reason: "disk full" }),
    );

    expect((await saveSessionState(state, createSessionState())).isErr()).toBe(true);
    expect(await state.session.get("linear-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "linear-1" })),
    );
  });

  test("rolls back update when index put fails, restoring prior state", async () => {
    const agentState = createInMemoryAgentState();
    const failingIndex = new FailingKeyValueStore(
      new MemoryKeyValueStore(sessionByOpencodeRecordSchema),
    );
    const state = {
      ...agentState,
      sessionByOpencode: failingIndex,
    };

    const original = createSessionState();
    await saveSessionState(state, original);

    const updated = createSessionState({ opencodeSessionId: "opencode-2" });
    failingIndex.failOnce(
      "put",
      new KvIoError({ path: "index", operation: "put", reason: "disk full" }),
    );

    expect((await saveSessionState(state, updated)).isErr()).toBe(true);
    expect(await state.session.get("linear-1")).toEqual(Result.ok(original));
    expect(await failingIndex.get("opencode-1")).toEqual(
      Result.ok({ linearSessionId: "linear-1" }),
    );
    expect(await failingIndex.get("opencode-2")).toEqual(
      Result.err(new KvNotFoundError({ key: "opencode-2" })),
    );
  });
});
