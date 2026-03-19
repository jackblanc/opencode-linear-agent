import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Result } from "better-result";
import {
  getSessionByOpencodeSessionId,
  readAccessToken,
  readAccessTokenSafe,
  readAnyAccessTokenSafe,
  savePendingPermission,
  savePendingQuestion,
  setStateRootPath,
  type PendingPermission,
  type PendingQuestion,
} from "@opencode-linear-agent/core";

const TEST_DIR = join(import.meta.dir, ".test-storage");
const TEST_STATE_ROOT = join(TEST_DIR, "state");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(value));
}

describe("storage", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
    setStateRootPath(TEST_STATE_ROOT);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("reads access token from auth namespace", async () => {
    await writeJson(join(TEST_STATE_ROOT, "auth", "org123.json"), {
      organizationId: "org123",
      accessToken: "test-token-abc",
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshToken: "refresh-token",
      appId: "app-1",
      installedAt: new Date().toISOString(),
    });

    expect(await readAccessToken("org123")).toBe("test-token-abc");
  });

  test("reads access token with malformed refresh metadata", async () => {
    await writeJson(join(TEST_STATE_ROOT, "auth", "org123.json"), {
      organizationId: "org123",
      accessToken: "test-token-abc",
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshToken: "refresh-token",
    });

    const result = await readAccessTokenSafe("org123");

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("test-token-abc");
    }
  });

  test("surfaces parse errors from auth record", async () => {
    const path = join(TEST_STATE_ROOT, "auth", "org123.json");
    await mkdir(join(TEST_STATE_ROOT, "auth"), { recursive: true });
    await Bun.write(path, "{ invalid");

    const result = await readAccessTokenSafe("org123");

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("parse_error");
      expect(result.error.path).toBe(path);
    }
  });

  test("reads any access token from auth namespace", async () => {
    await writeJson(join(TEST_STATE_ROOT, "auth", "org123.json"), {
      organizationId: "org123",
      accessToken: "token-org123",
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshToken: "refresh-token",
      appId: "app-1",
      installedAt: new Date().toISOString(),
    });

    const result = await readAnyAccessTokenSafe();

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("token-org123");
    }
  });

  test("surfaces auth directory read errors", async () => {
    await Bun.write(join(TEST_STATE_ROOT, "auth"), "not-a-directory");

    const result = await readAnyAccessTokenSafe();

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.path).toBe(join(TEST_STATE_ROOT, "auth"));
    }
  });

  test("resolves session by opencode session id via index", async () => {
    await writeJson(join(TEST_STATE_ROOT, "session-by-opencode", "oc-1.json"), {
      linearSessionId: "lin-1",
    });
    await writeJson(join(TEST_STATE_ROOT, "session", "lin-1.json"), {
      opencodeSessionId: "oc-1",
      linearSessionId: "lin-1",
      organizationId: "org123",
      issueId: "CODE-1",
      branchName: "feat/code-1",
      workdir: "/tmp/workdir-a",
      lastActivityTime: Date.now(),
    });

    const session = await getSessionByOpencodeSessionId("oc-1");

    expect(session).toEqual({
      sessionId: "lin-1",
      issueId: "CODE-1",
      organizationId: "org123",
      workdir: "/tmp/workdir-a",
    });
  });

  test("saves pending question in question namespace", async () => {
    const question: PendingQuestion = {
      requestId: "req-123",
      opencodeSessionId: "opencode-456",
      linearSessionId: "linear-789",
      workdir: "/path/to/workdir",
      issueId: "CODE-42",
      questions: [],
      answers: [],
      createdAt: Date.now(),
    };

    await savePendingQuestion(question);

    const stored = JSON.parse(
      await readFile(
        join(TEST_STATE_ROOT, "question", "linear-789.json"),
        "utf8",
      ),
    );
    expect(stored).toEqual(question);
  });

  test("saves pending permission in permission namespace", async () => {
    const permission: PendingPermission = {
      requestId: "req-123",
      opencodeSessionId: "opencode-456",
      linearSessionId: "linear-789",
      workdir: "/path/to/workdir",
      issueId: "CODE-42",
      permission: "Edit",
      patterns: ["*.ts"],
      metadata: { scope: "project" },
      createdAt: Date.now(),
    };

    await savePendingPermission(permission);

    const stored = JSON.parse(
      await readFile(
        join(TEST_STATE_ROOT, "permission", "linear-789.json"),
        "utf8",
      ),
    );
    expect(stored).toEqual(permission);
  });
});
