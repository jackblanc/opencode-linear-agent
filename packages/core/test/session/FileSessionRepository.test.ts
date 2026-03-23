import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Result } from "better-result";

import { FileSessionRepository } from "../../src/session/FileSessionRepository";
import { createFileAgentState } from "../../src/state/root";
import type {
  PendingPermission,
  PendingQuestion,
} from "../../src/session/SessionRepository";
import type { SessionState } from "../../src/session/SessionState";

const TEST_DIR = join(import.meta.dir, ".test-session-repository");
const TEST_STATE_ROOT = join(TEST_DIR, "state");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(value));
}

function createSessionState(
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    linearSessionId: "linear-1",
    opencodeSessionId: "opencode-1",
    organizationId: "org-1",
    issueId: "issue-1",
    repoDirectory: "/tmp/repo",
    branchName: "feature/code-1",
    workdir: "/tmp/worktree",
    lastActivityTime: Date.now(),
    ...overrides,
  };
}

async function getSessionByOpencodeSessionId(
  statePath: string,
  opencodeSessionId: string,
): Promise<SessionState | null> {
  const state = createFileAgentState(statePath);
  const index = await state.sessionByOpencode.get(opencodeSessionId);
  if (Result.isError(index) || !index.value) {
    return null;
  }

  const hasSession = await state.session.has(index.value.linearSessionId);
  if (Result.isError(hasSession)) {
    return null;
  }
  if (!hasSession.value) {
    await state.sessionByOpencode.delete(opencodeSessionId);
    return null;
  }

  const session = await state.session.get(index.value.linearSessionId);
  if (Result.isError(session)) {
    return null;
  }
  if (session.value) {
    return session.value;
  }

  await state.sessionByOpencode.delete(opencodeSessionId);
  return null;
}

describe("FileSessionRepository", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("saves canonical session and opencode index", async () => {
    const repo = new FileSessionRepository(TEST_STATE_ROOT);
    const state = createSessionState();

    await repo.save(state);

    expect(await repo.get("linear-1")).toEqual(state);
    expect(
      await readJson(
        join(TEST_STATE_ROOT, "session-by-opencode", "opencode-1.json"),
      ),
    ).toEqual({ linearSessionId: "linear-1" });
  });

  test("updates opencode index when session id changes", async () => {
    const repo = new FileSessionRepository(TEST_STATE_ROOT);

    await repo.save(createSessionState());
    await repo.save(createSessionState({ opencodeSessionId: "opencode-2" }));

    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "session-by-opencode", "opencode-1.json"),
      ).exists(),
    ).toBe(false);
    expect(
      await readJson(
        join(TEST_STATE_ROOT, "session-by-opencode", "opencode-2.json"),
      ),
    ).toEqual({ linearSessionId: "linear-1" });
  });

  test("rolls back session write if index update fails", async () => {
    const repo = new FileSessionRepository(TEST_STATE_ROOT);

    await Bun.write(join(TEST_STATE_ROOT, "session-by-opencode"), "blocked");

    let threw = false;
    try {
      await repo.save(createSessionState());
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(await repo.get("linear-1")).toBeNull();
  });

  test("deletes session index and pending records on cleanup", async () => {
    const repo = new FileSessionRepository(TEST_STATE_ROOT);
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
    await writeJson(join(TEST_STATE_ROOT, "repo-selection", "linear-1.json"), {
      linearSessionId: "linear-1",
      issueId: "issue-1",
      options: [],
      createdAt: Date.now(),
    });

    await repo.delete("linear-1");

    expect(await repo.get("linear-1")).toBeNull();
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "session-by-opencode", "opencode-1.json"),
      ).exists(),
    ).toBe(false);
    expect(await repo.getPendingQuestion("linear-1")).toBeNull();
    expect(await repo.getPendingPermission("linear-1")).toBeNull();
    expect(await repo.getPendingRepoSelection("linear-1")).toBeNull();
  });

  test("cleans stale session index on lookup", async () => {
    await writeJson(
      join(TEST_STATE_ROOT, "session-by-opencode", "opencode-1.json"),
      {
        linearSessionId: "linear-1",
      },
    );

    expect(
      await getSessionByOpencodeSessionId(TEST_STATE_ROOT, "opencode-1"),
    ).toBeNull();
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "session-by-opencode", "opencode-1.json"),
      ).exists(),
    ).toBe(false);
  });
});
