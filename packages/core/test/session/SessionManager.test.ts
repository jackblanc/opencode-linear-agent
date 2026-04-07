import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { describe, test, expect } from "bun:test";

import type { SessionState } from "../../src/state/schema";

import { OpencodeUnknownError } from "../../src/opencode-service/errors";
import { OpencodeService } from "../../src/opencode-service/OpencodeService";
import { SessionManager } from "../../src/session/SessionManager";
import { SessionRepository } from "../../src/state/SessionRepository";
import { createInMemoryAgentState } from "../state/InMemoryAgentNamespace";

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    linearSessionId: "linear-1",
    opencodeSessionId: "opencode-old",
    organizationId: "org-1",
    issueId: "issue-1",
    projectId: "project-1",
    branchName: "feature/code-1",
    workdir: "/tmp/worktree-1",
    lastActivityTime: Date.now(),
    ...overrides,
  };
}

async function createRepository(state?: SessionState): Promise<{
  repository: SessionRepository;
}> {
  const agentState = createInMemoryAgentState();
  const repository = new SessionRepository(agentState);
  if (state) {
    await repository.save(state);
  }

  return {
    repository,
  };
}

describe("SessionManager", () => {
  test("returns resume error instead of recreating existing session", async () => {
    const existing = createSessionState();

    const { repository } = await createRepository(existing);
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );

    Object.defineProperty(opencode, "getSession", {
      value: async () => Result.err(new OpencodeUnknownError({ reason: "missing" })),
    });

    const manager = new SessionManager(opencode, repository);
    const result = await manager.getOrCreateSession(
      "linear-1",
      "org-1",
      "issue-1",
      "project-2",
      "feature/code-1",
      "/tmp/worktree-1",
    );

    expect(Result.isError(result)).toBe(true);
    expect(await repository.get("linear-1")).toEqual(existing);
  });

  test("creates fresh session when no existing state", async () => {
    const agentState = createInMemoryAgentState();
    const repository = new SessionRepository(agentState);
    const opencode = new OpencodeService(
      createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    );

    Object.defineProperty(opencode, "createSession", {
      value: async () => Result.ok({ id: "opencode-new" }),
    });

    const manager = new SessionManager(opencode, repository);
    const result = await manager.getOrCreateSession(
      "linear-1",
      "org-1",
      "issue-1",
      "project-1",
      "feature/code-1",
      "/tmp/worktree-1",
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.isNewSession).toBe(true);
      expect(result.value.existingState).toBeNull();
    }

    expect(await repository.get("linear-1")).toEqual({
      linearSessionId: "linear-1",
      opencodeSessionId: "opencode-new",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/worktree-1",
      lastActivityTime: expect.any(Number),
    });
  });
});
