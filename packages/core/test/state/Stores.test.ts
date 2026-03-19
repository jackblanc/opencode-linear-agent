import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  FileOAuthStateStore,
  FileSessionRepository,
  FileTokenStore,
  getSessionByOpencodeSessionId,
  setStateRootPath,
  type PendingPermission,
  type PendingQuestion,
  type SessionState,
} from "../../src";
import type { AuthRecord } from "../../src/storage/types";

const TEST_DIR = join(import.meta.dir, ".test-state-stores");
const TEST_STATE_ROOT = join(TEST_DIR, "state");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(value));
}

function createAuthRecord(overrides: Partial<AuthRecord> = {}): AuthRecord {
  return {
    organizationId: "org-1",
    accessToken: "token-1",
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: "refresh-1",
    appId: "app-1",
    installedAt: new Date().toISOString(),
    workspaceName: "workspace-1",
    ...overrides,
  };
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

describe("FileTokenStore", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("stores one auth record per org", async () => {
    const store = new FileTokenStore(TEST_STATE_ROOT);
    const record = createAuthRecord();

    await store.putAuthRecord(record);

    expect(await store.getAuthRecord("org-1")).toEqual(record);
    expect(await store.getAccessToken("org-1")).toBe("token-1");
    expect(await store.getRefreshTokenData("org-1")).toEqual({
      refreshToken: "refresh-1",
      appId: "app-1",
      organizationId: "org-1",
      installedAt: record.installedAt,
      workspaceName: "workspace-1",
    });
  });

  test("hides expired access tokens but keeps auth record", async () => {
    const store = new FileTokenStore(TEST_STATE_ROOT);
    await store.putAuthRecord(
      createAuthRecord({ accessTokenExpiresAt: Date.now() - 1 }),
    );

    expect(await store.getAccessToken("org-1")).toBeNull();
    expect(await store.getAuthRecord("org-1")).not.toBeNull();
  });

  test("reads access token even if refresh metadata is malformed", async () => {
    await writeJson(join(TEST_STATE_ROOT, "auth", "org-1.json"), {
      organizationId: "org-1",
      accessToken: "token-1",
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshToken: "refresh-1",
    });

    const store = new FileTokenStore(TEST_STATE_ROOT);

    expect(await store.getAccessToken("org-1")).toBe("token-1");
  });
});

describe("FileOAuthStateStore", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("issues and consumes valid oauth state", async () => {
    const store = new FileOAuthStateStore(TEST_STATE_ROOT);
    const now = Date.now();

    await store.issue("state-1", now, now + 60_000);

    expect(await store.consume("state-1", now + 1)).toBe(true);
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "oauth-state", "state-1.json"),
      ).exists(),
    ).toBe(false);
  });

  test("rejects expired oauth state and deletes it", async () => {
    const store = new FileOAuthStateStore(TEST_STATE_ROOT);
    const now = Date.now();

    await store.issue("state-1", now, now + 10);

    expect(await store.consume("state-1", now + 11)).toBe(false);
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "oauth-state", "state-1.json"),
      ).exists(),
    ).toBe(false);
  });
});

describe("FileSessionRepository", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
    setStateRootPath(TEST_STATE_ROOT);
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

    expect(await getSessionByOpencodeSessionId("opencode-1")).toBeNull();
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "session-by-opencode", "opencode-1.json"),
      ).exists(),
    ).toBe(false);
  });
});
