import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { PendingPermission, PendingQuestion, SessionState } from "../../src/state/schema";

import { KvIoError, KvNotFoundError } from "../../src/kv/errors";
import { sessionByOpencodeRecordSchema } from "../../src/state/schema";
import { SessionRepository } from "../../src/state/SessionRepository";
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

describe("SessionRepository", () => {
  test("saves canonical session and opencode index", async () => {
    const agentState = createInMemoryAgentState();
    const repo = new SessionRepository(agentState);
    const state = createSessionState();

    await repo.save(state);

    expect(await repo.get("linear-1")).toEqual(state);
    expect(await agentState.sessionByOpencode.get("opencode-1")).toEqual(
      Result.ok({ linearSessionId: "linear-1" }),
    );
  });

  test("updates opencode index when session id changes", async () => {
    const agentState = createInMemoryAgentState();
    const repo = new SessionRepository(agentState);

    await repo.save(createSessionState());
    await repo.save(createSessionState({ opencodeSessionId: "opencode-2" }));

    expect(await agentState.sessionByOpencode.get("opencode-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "opencode-1" })),
    );
    expect(await agentState.sessionByOpencode.get("opencode-2")).toEqual(
      Result.ok({ linearSessionId: "linear-1" }),
    );
  });

  test("deletes session index and pending records on cleanup", async () => {
    const agentState = createInMemoryAgentState();
    const repo = new SessionRepository(agentState);
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

    await repo.save(createSessionState());
    await repo.savePendingQuestion(question);
    await repo.savePendingPermission(permission);
    await agentState.repoSelection.put("linear-1", {
      linearSessionId: "linear-1",
      issueId: "issue-1",
      options: [],
      createdAt: Date.now(),
    });

    await repo.delete("linear-1");

    expect(await repo.get("linear-1")).toBeNull();
    expect(await agentState.sessionByOpencode.get("opencode-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "opencode-1" })),
    );
    expect(await repo.getPendingQuestion("linear-1")).toBeNull();
    expect(await repo.getPendingPermission("linear-1")).toBeNull();
    expect(await repo.getPendingRepoSelection("linear-1")).toBeNull();
  });

  test("rolls back fresh save when index put fails", async () => {
    const agentState = createInMemoryAgentState();
    const failingIndex = new FailingKeyValueStore(
      new MemoryKeyValueStore(sessionByOpencodeRecordSchema),
    );
    const repo = new SessionRepository({
      ...agentState,
      sessionByOpencode: failingIndex,
    });

    failingIndex.failOnce(
      "put",
      new KvIoError({ path: "index", operation: "put", reason: "disk full" }),
    );

    let threw = false;
    try {
      await repo.save(createSessionState());
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(await repo.get("linear-1")).toBeNull();
  });

  test("rolls back update when index put fails, restoring prior state", async () => {
    const agentState = createInMemoryAgentState();
    const failingIndex = new FailingKeyValueStore(
      new MemoryKeyValueStore(sessionByOpencodeRecordSchema),
    );
    const repo = new SessionRepository({
      ...agentState,
      sessionByOpencode: failingIndex,
    });

    const original = createSessionState();
    await repo.save(original);

    const updated = createSessionState({ opencodeSessionId: "opencode-2" });
    failingIndex.failOnce(
      "put",
      new KvIoError({ path: "index", operation: "put", reason: "disk full" }),
    );

    let threw = false;
    try {
      await repo.save(updated);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(await repo.get("linear-1")).toEqual(original);
    expect(await failingIndex.get("opencode-1")).toEqual(
      Result.ok({ linearSessionId: "linear-1" }),
    );
    expect(await failingIndex.get("opencode-2")).toEqual(
      Result.err(new KvNotFoundError({ key: "opencode-2" })),
    );
  });
});
