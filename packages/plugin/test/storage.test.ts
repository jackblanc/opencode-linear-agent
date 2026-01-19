import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readAccessToken,
  savePendingQuestion,
  savePendingPermission,
  setStorePath,
  type PendingQuestion,
  type PendingPermission,
} from "../src/storage";

const TEST_DIR = join(import.meta.dir, ".test-storage");
const TEST_STORE_PATH = join(TEST_DIR, "store.json");

describe("storage", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    setStorePath(TEST_STORE_PATH);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("readAccessToken", () => {
    test("should return token when it exists", async () => {
      const storeData = {
        "token:access:org123": {
          value: "test-token-abc",
        },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBe("test-token-abc");
    });

    test("should return null when token does not exist", async () => {
      const storeData = {};
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBeNull();
    });

    test("should return null when file does not exist", async () => {
      const token = await readAccessToken("org123");

      expect(token).toBeNull();
    });

    test("should return null when token is expired", async () => {
      const storeData = {
        "token:access:org123": {
          value: "expired-token",
          expires: Date.now() - 1000, // Expired 1 second ago
        },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBeNull();
    });

    test("should return token when expiration is in the future", async () => {
      const storeData = {
        "token:access:org123": {
          value: "valid-token",
          expires: Date.now() + 60000, // Expires in 1 minute
        },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));

      const token = await readAccessToken("org123");

      expect(token).toBe("valid-token");
    });

    test("should return token for correct organization only", async () => {
      const storeData = {
        "token:access:org123": { value: "token-org123" },
        "token:access:org456": { value: "token-org456" },
      };
      await Bun.write(TEST_STORE_PATH, JSON.stringify(storeData));

      const token123 = await readAccessToken("org123");
      const token456 = await readAccessToken("org456");
      const tokenOther = await readAccessToken("other");

      expect(token123).toBe("token-org123");
      expect(token456).toBe("token-org456");
      expect(tokenOther).toBeNull();
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
              { label: "Option A", description: "First option" },
              { label: "Option B", description: "Second option" },
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
        "token:access:org123": { value: "existing-token" },
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
      expect(stored["token:access:org123"]).toBeDefined();
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
        "token:access:org123": { value: "existing-token" },
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
      expect(stored["token:access:org123"]).toBeDefined();
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
