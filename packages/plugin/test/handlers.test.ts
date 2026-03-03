import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Part } from "@opencode-ai/sdk";
import type { LinearService } from "@linear-opencode-agent/core";
import { Result } from "better-result";
import { handleUserMessage } from "../src/handlers";
import { setStorePath } from "../src/storage";

const TEST_DIR = join(import.meta.dir, ".test-handlers");
const TEST_STORE_PATH = join(TEST_DIR, "store.json");

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
): Promise<void> {
  const store = {
    "token:access:org-1": { value: "token-1" },
    [`session:${linearSessionId}`]: {
      value: {
        opencodeSessionId,
        linearSessionId,
        issueId: "CODE-150",
        branchName: "feat/code-150",
        workdir: "/tmp/workdir",
        lastActivityTime: Date.now(),
      },
    },
  };
  await Bun.write(TEST_STORE_PATH, JSON.stringify(store));
}

describe("handleUserMessage", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    setStorePath(TEST_STORE_PATH);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("posts user text as thought activity", async () => {
    await seedStore("oc-1", "lin-1");
    const calls: Array<{ sessionId: string; body: string }> = [];

    await handleUserMessage(
      "oc-1",
      "msg-1",
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
      "oc-2",
      "msg-2",
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

  test("dedupes by message id", async () => {
    await seedStore("oc-3", "lin-3");
    const calls: Array<{ sessionId: string; body: string }> = [];

    await handleUserMessage(
      "oc-3",
      "msg-3",
      [textPart("oc-3", "msg-3", "once")],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );
    await handleUserMessage(
      "oc-3",
      "msg-3",
      [textPart("oc-3", "msg-3", "once")],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([{ sessionId: "lin-3", body: "User: once" }]);
  });

  test("dedupes concurrent deliveries for same message id", async () => {
    await seedStore("oc-4", "lin-4");
    const calls: Array<{ sessionId: string; body: string }> = [];

    const pending = new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    const linear = {
      ...createLinear(calls),
      postActivity: async (
        sessionId: string,
        content: { type: "thought"; body: string },
      ): ReturnType<LinearService["postActivity"]> => {
        await pending;
        calls.push({ sessionId, body: content.body });
        return Result.ok(undefined);
      },
    } satisfies LinearService;

    await Promise.all([
      handleUserMessage(
        "oc-4",
        "msg-4",
        [textPart("oc-4", "msg-4", "race")],
        async () => "token-1",
        () => linear,
        () => {},
      ),
      handleUserMessage(
        "oc-4",
        "msg-4",
        [textPart("oc-4", "msg-4", "race")],
        async () => "token-1",
        () => linear,
        () => {},
      ),
    ]);

    expect(calls).toEqual([{ sessionId: "lin-4", body: "User: race" }]);
  });
});
