import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Part } from "@opencode-ai/sdk";
import type { LinearService } from "@opencode-linear-agent/core";
import { Result } from "better-result";
import { handleUserMessage } from "../src/handlers";
import { setAuthPath, setStorePath } from "../src/storage";

const TEST_DIR = join(import.meta.dir, ".test-handlers");
const TEST_STORE_PATH = join(TEST_DIR, "store.json");
const TEST_AUTH_PATH = join(TEST_DIR, "auth.json");

function createLinear(
  calls: Array<{ sessionId: string; body: string }>,
): LinearService {
  return {
    postActivity: async (sessionId, content) => {
      if (content.type === "thought" && content.body) {
        calls.push({ sessionId, body: content.body });
      }
      return Result.ok(undefined);
    },
    postStageActivity: async () => Result.ok(undefined),
    postError: async () => Result.ok(undefined),
    postElicitation: async () => Result.ok(undefined),
    setExternalLink: async () => Result.ok(undefined),
    updatePlan: async () => Result.ok(undefined),
    getIssue: async () =>
      Result.ok({
        id: "issue-1",
        identifier: "CODE-1",
        title: "t",
        url: "https://linear.app",
      }),
    getIssueLabels: async () => Result.ok([]),
    getIssueAttachments: async () => Result.ok([]),
    getIssueRepositorySuggestions: async () => Result.ok([]),
    setIssueRepoLabel: async () => Result.ok(undefined),
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({
        id: "state-1",
        name: "Todo",
        type: "unstarted",
      }),
  };
}

function textPart(sessionID: string, messageID: string, text: string): Part {
  return {
    id: `part-${messageID}`,
    sessionID,
    messageID,
    type: "text",
    text,
  };
}

async function seedStore(
  opencodeSessionId: string,
  linearSessionId: string,
  workdir = "/tmp/workdir",
): Promise<void> {
  const store = {
    [`session:${linearSessionId}`]: {
      value: {
        opencodeSessionId,
        linearSessionId,
        organizationId: "org-1",
        issueId: "CODE-150",
        branchName: "feat/code-150",
        workdir,
        lastActivityTime: Date.now(),
      },
    },
  };
  await Bun.write(TEST_STORE_PATH, JSON.stringify(store));
  await Bun.write(
    TEST_AUTH_PATH,
    JSON.stringify({
      version: 1,
      organizations: {
        "org-1": {
          accessToken: {
            value: "token-1",
            expiresAt: Date.now() + 60000,
          },
        },
      },
    }),
  );
}

describe("handleUserMessage", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    setStorePath(TEST_STORE_PATH);
    setAuthPath(TEST_AUTH_PATH);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("posts user text as thought activity", async () => {
    await seedStore("oc-1", "lin-1");
    const calls: Array<{ sessionId: string; body: string }> = [];

    await handleUserMessage(
      "/tmp/workdir",
      [textPart("oc-1", "msg-1", "hello from user")],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([
      { sessionId: "lin-1", body: "User: hello from user" },
    ]);
  });

  test("strips leading frontmatter", async () => {
    await seedStore("oc-2", "lin-2");
    const calls: Array<{ sessionId: string; body: string }> = [];

    await handleUserMessage(
      "/tmp/workdir",
      [
        textPart(
          "oc-2",
          "msg-2",
          "---\nlinear_session: abc\nlinear_issue: CODE-150\n---\nfollow-up question",
        ),
      ],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([
      { sessionId: "lin-2", body: "User: follow-up question" },
    ]);
  });

  test("posts duplicate deliveries", async () => {
    await seedStore("oc-3", "lin-3");
    const calls: Array<{ sessionId: string; body: string }> = [];

    await handleUserMessage(
      "/tmp/workdir",
      [textPart("oc-3", "msg-3", "once")],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );
    await handleUserMessage(
      "/tmp/workdir",
      [textPart("oc-3", "msg-3", "once")],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([
      { sessionId: "lin-3", body: "User: once" },
      { sessionId: "lin-3", body: "User: once" },
    ]);
  });
});
