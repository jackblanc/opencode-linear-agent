import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import {
  readAccessToken,
  readAccessTokenSafe,
  readAnyAccessTokenSafe,
  getSessionAsync,
  getSessionAsyncSafe,
  savePendingQuestion,
  savePendingPermission,
  setAuthPath,
  setStorePath,
  type PendingQuestion,
  type PendingPermission,
} from "../src/storage";

const TEST_DIR = join(import.meta.dir, ".test-storage");
const TEST_STORE_PATH = join(TEST_DIR, "store.json");
const TEST_AUTH_PATH = join(TEST_DIR, "auth.json");

describe("storage", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    setStorePath(TEST_STORE_PATH);
    setAuthPath(TEST_AUTH_PATH);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("readAccessToken", () => {
    test("should return token when it exists", async () => {
      const storeData = {
        version: 1,
        organizations: {
          org123: {
            accessToken: {
              value: "test-token-abc",
              expiresAt: Date.now() + 60000,
            },
          },
        },
      };
      await Bun.write(TEST_AUTH_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBe("test-token-abc");
    });

    test("should return null when token does not exist", async () => {
      await Bun.write(
        TEST_AUTH_PATH,
        JSON.stringify({ version: 1, organizations: {} }),
      );

      const token = await readAccessToken("org123");

      expect(token).toBeNull();
    });

    test("should return null when file does not exist", async () => {
      const token = await readAccessToken("org123");

      expect(token).toBeNull();
    });

    test("should return null when token is expired", async () => {
      const storeData = {
        version: 1,
        organizations: {
          org123: {
            accessToken: {
              value: "expired-token",
              expiresAt: Date.now() - 1000,
            },
          },
        },
      };
      await Bun.write(TEST_AUTH_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBeNull();
    });

    test("should return token when expiration is in the future", async () => {
      const storeData = {
        version: 1,
        organizations: {
          org123: {
            accessToken: {
              value: "valid-token",
              expiresAt: Date.now() + 60000,
            },
          },
        },
      };
      await Bun.write(TEST_AUTH_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBe("valid-token");
    });

    test("should return token for correct organization only", async () => {
      const storeData = {
        version: 1,
        organizations: {
          org123: {
            accessToken: {
              value: "token-org123",
              expiresAt: Date.now() + 60000,
            },
          },
          org456: {
            accessToken: {
              value: "token-org456",
              expiresAt: Date.now() + 60000,
            },
          },
        },
      };
      await Bun.write(TEST_AUTH_PATH, JSON.stringify(storeData));

      const token123 = await readAccessToken("org123");
      const token456 = await readAccessToken("org456");
      const tokenOther = await readAccessToken("other");

      expect(token123).toBe("token-org123");
      expect(token456).toBe("token-org456");
      expect(tokenOther).toBeNull();
    });

    test("readAccessTokenSafe should return parse_error for invalid JSON", async () => {
      await Bun.write(TEST_AUTH_PATH, "{ invalid");

      const result = await readAccessTokenSafe("org123");

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.kind).toBe("parse_error");
        expect(result.error.path).toBe(TEST_AUTH_PATH);
      }
    });

    test("readAnyAccessTokenSafe should return schema_error for invalid shape", async () => {
      await Bun.write(TEST_AUTH_PATH, JSON.stringify(["not-an-object"]));

      const result = await readAnyAccessTokenSafe();

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.kind).toBe("schema_error");
        expect(result.error.path).toBe(TEST_AUTH_PATH);
      }
    });

    test("readAnyAccessTokenSafe should return first token when multiple org tokens exist", async () => {
      await Bun.write(
        TEST_AUTH_PATH,
        JSON.stringify({
          version: 1,
          organizations: {
            org123: {
              accessToken: {
                value: "token-org123",
                expiresAt: Date.now() + 60000,
              },
            },
            org456: {
              accessToken: {
                value: "token-org456",
                expiresAt: Date.now() + 60000,
              },
            },
          },
        }),
      );

      const result = await readAnyAccessTokenSafe();

      expect(Result.isError(result)).toBe(false);
      expect(Result.isError(result) ? "unexpected" : result.value).toBe(
        "token-org123",
      );
    });
  });

  describe("getSessionAsync", () => {
    test("should resolve session by workdir", async () => {
      const storeData = {
        "session:lin-1": {
          value: {
            opencodeSessionId: "oc-1",
            linearSessionId: "lin-1",
            organizationId: "org123",
            issueId: "CODE-1",
            branchName: "feat/code-1",
            workdir: "/tmp/workdir-a",
            lastActivityTime: Date.now(),
          },
        },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));
      await Bun.write(
        TEST_AUTH_PATH,
        JSON.stringify({
          version: 1,
          organizations: {
            org123: {
              accessToken: {
                value: "test-token-abc",
                expiresAt: Date.now() + 60000,
              },
            },
          },
        }),
      );

      const session = await getSessionAsync("/tmp/workdir-a");

      expect(session).toEqual({
        sessionId: "lin-1",
        issueId: "CODE-1",
        organizationId: "org123",
        workdir: "/tmp/workdir-a",
      });
    });

    test("should pick latest session for same workdir", async () => {
      const storeData = {
        "session:lin-old": {
          value: {
            opencodeSessionId: "oc-old",
            linearSessionId: "lin-old",
            organizationId: "org123",
            issueId: "CODE-1",
            branchName: "feat/code-1",
            workdir: "/tmp/workdir-a",
            lastActivityTime: 100,
          },
        },
        "session:lin-new": {
          value: {
            opencodeSessionId: "oc-new",
            linearSessionId: "lin-new",
            organizationId: "org123",
            issueId: "CODE-2",
            branchName: "feat/code-2",
            workdir: "/tmp/workdir-a",
            lastActivityTime: 200,
          },
        },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));
      await Bun.write(
        TEST_AUTH_PATH,
        JSON.stringify({
          version: 1,
          organizations: {
            org123: {
              accessToken: {
                value: "test-token-abc",
                expiresAt: Date.now() + 60000,
              },
            },
          },
        }),
      );

      const session = await getSessionAsync("/tmp/workdir-a");

      expect(session?.sessionId).toBe("lin-new");
      expect(session?.issueId).toBe("CODE-2");
    });

    test("getSessionAsyncSafe should return store parse_error for invalid store JSON", async () => {
      await Bun.write(TEST_STORE_PATH, "{ invalid");
      await Bun.write(
        TEST_AUTH_PATH,
        JSON.stringify({
          version: 1,
          organizations: {
            org123: {
              accessToken: {
                value: "test-token-abc",
                expiresAt: Date.now() + 60000,
              },
            },
          },
        }),
      );

      const result = await getSessionAsyncSafe("/tmp/workdir-a");

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.fileType).toBe("store");
        expect(result.error.kind).toBe("parse_error");
        expect(result.error.path).toBe(TEST_STORE_PATH);
      }
    });

    test("getSessionAsyncSafe should return auth parse_error for invalid auth JSON", async () => {
      await Bun.write(
        TEST_STORE_PATH,
        JSON.stringify({
          "session:lin-1": {
            value: {
              opencodeSessionId: "oc-1",
              linearSessionId: "lin-1",
              organizationId: "org123",
              issueId: "CODE-1",
              branchName: "feat/code-1",
              workdir: "/tmp/workdir-a",
              lastActivityTime: Date.now(),
            },
          },
        }),
      );
      await Bun.write(TEST_AUTH_PATH, "{ invalid");

      const result = await getSessionAsyncSafe("/tmp/workdir-a");

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.fileType).toBe("auth");
        expect(result.error.kind).toBe("parse_error");
        expect(result.error.path).toBe(TEST_AUTH_PATH);
      }
    });

    test("should resolve session using stored organization when multiple org tokens exist", async () => {
      await Bun.write(
        TEST_STORE_PATH,
        JSON.stringify({
          "session:lin-1": {
            value: {
              opencodeSessionId: "oc-1",
              linearSessionId: "lin-1",
              organizationId: "org456",
              issueId: "CODE-1",
              branchName: "feat/code-1",
              workdir: "/tmp/workdir-a",
              lastActivityTime: Date.now(),
            },
          },
        }),
      );
      await Bun.write(
        TEST_AUTH_PATH,
        JSON.stringify({
          version: 1,
          organizations: {
            org123: {
              accessToken: {
                value: "token-org123",
                expiresAt: Date.now() + 60000,
              },
            },
            org456: {
              accessToken: {
                value: "token-org456",
                expiresAt: Date.now() + 60000,
              },
            },
          },
        }),
      );

      const session = await getSessionAsync("/tmp/workdir-a");

      expect(session).toEqual({
        sessionId: "lin-1",
        issueId: "CODE-1",
        organizationId: "org456",
        workdir: "/tmp/workdir-a",
      });
    });
  });

  describe("savePendingQuestion", () => {
    test("should save pending question to store", async () => {
      const question: PendingQuestion = {
        requestId: "req-123",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        questions: [
          {
            question: "Which option?",
            header: "Select",
            options: [
              {
                label: "Option A",
                description: "First option",
                value: "First option",
                aliases: ["Option A", "First option"],
              },
              {
                label: "Option B",
                description: "Second option",
                value: "Second option",
                aliases: ["Option B", "Second option"],
              },
            ],
          },
        ],
        answers: [null],
        createdAt: Date.now(),
      };

      await savePendingQuestion(question);

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));
      expect(stored["question:linear-789"]).toBeDefined();
      expect(stored["question:linear-789"].value).toEqual(question);
    });

    test("should create store file if it does not exist", async () => {
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

      const exists = await Bun.file(TEST_STORE_PATH).exists();
      expect(exists).toBe(true);
    });

    test("should preserve existing data when saving", async () => {
      const existingData = {
        "session:existing": { value: { workdir: "/tmp" } },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(existingData));

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

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));
      expect(stored["session:existing"]).toBeDefined();
      expect(stored["question:linear-789"]).toBeDefined();
    });

    test("should overwrite existing question for same session", async () => {
      const existingQuestion: PendingQuestion = {
        requestId: "req-old",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        questions: [],
        answers: [],
        createdAt: Date.now() - 1000,
      };
      await savePendingQuestion(existingQuestion);

      const newQuestion: PendingQuestion = {
        requestId: "req-new",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        questions: [{ question: "New question?", header: "Q", options: [] }],
        answers: [null],
        createdAt: Date.now(),
      };
      await savePendingQuestion(newQuestion);

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));
      expect(stored["question:linear-789"].value.requestId).toBe("req-new");
    });
  });

  describe("savePendingPermission", () => {
    test("should save pending permission to store", async () => {
      const permission: PendingPermission = {
        requestId: "req-123",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        permission: "Bash",
        patterns: ["npm install", "bun install"],
        metadata: { dangerous: true },
        createdAt: Date.now(),
      };

      await savePendingPermission(permission);

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));
      expect(stored["permission:linear-789"]).toBeDefined();
      expect(stored["permission:linear-789"].value).toEqual(permission);
    });

    test("should create store file if it does not exist", async () => {
      const permission: PendingPermission = {
        requestId: "req-123",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        permission: "Edit",
        patterns: [],
        metadata: {},
        createdAt: Date.now(),
      };

      await savePendingPermission(permission);

      const exists = await Bun.file(TEST_STORE_PATH).exists();
      expect(exists).toBe(true);
    });

    test("should preserve existing data when saving", async () => {
      const existingData = {
        "question:linear-123": {
          value: { requestId: "q-123" },
        },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(existingData));

      const permission: PendingPermission = {
        requestId: "req-123",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        permission: "Edit",
        patterns: [],
        metadata: {},
        createdAt: Date.now(),
      };

      await savePendingPermission(permission);

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));
      expect(stored["question:linear-123"]).toBeDefined();
      expect(stored["permission:linear-789"]).toBeDefined();
    });

    test("should overwrite existing permission for same session", async () => {
      const existingPermission: PendingPermission = {
        requestId: "req-old",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        permission: "Bash",
        patterns: [],
        metadata: {},
        createdAt: Date.now() - 1000,
      };
      await savePendingPermission(existingPermission);

      const newPermission: PendingPermission = {
        requestId: "req-new",
        opencodeSessionId: "opencode-456",
        linearSessionId: "linear-789",
        workdir: "/path/to/workdir",
        issueId: "CODE-42",
        permission: "Edit",
        patterns: ["*.ts"],
        metadata: { scope: "project" },
        createdAt: Date.now(),
      };
      await savePendingPermission(newPermission);

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));
      expect(stored["permission:linear-789"].value.requestId).toBe("req-new");
      expect(stored["permission:linear-789"].value.permission).toBe("Edit");
    });
  });

  describe("concurrent writes", () => {
    test("should handle concurrent saves without data loss", async () => {
      const questions = Array.from({ length: 10 }, (_, i) => ({
        requestId: `req-${i}`,
        opencodeSessionId: `opencode-${i}`,
        linearSessionId: `linear-${i}`,
        workdir: "/path/to/workdir",
        issueId: `CODE-${i}`,
        questions: [],
        answers: [],
        createdAt: Date.now(),
      }));

      // Save all questions concurrently
      await Promise.all(questions.map(async (q) => savePendingQuestion(q)));

      const stored = JSON.parse(await readFile(TEST_STORE_PATH, "utf-8"));

      // All questions should be saved
      for (let i = 0; i < 10; i++) {
        expect(stored[`question:linear-${i}`]).toBeDefined();
      }
    });
  });
});
