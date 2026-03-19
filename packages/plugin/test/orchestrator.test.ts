import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Event, Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2";
import {
  setStateRootPath,
  type LinearService,
} from "@opencode-linear-agent/core";
import type { ActivityContent, IssueState } from "../../core/src/linear/types";
import { Result } from "better-result";
import { handleEvent } from "../src/orchestrator";

const TEST_DIR = join(import.meta.dir, ".test-orchestrator");
const TEST_STATE_ROOT = join(TEST_DIR, "state");

interface Call {
  sessionId: string;
  content: ActivityContent;
  ephemeral: boolean | undefined;
}

interface ExtendedLinearService extends LinearService {
  getIssueRepositorySuggestions(
    issueId: string,
    agentSessionId: string,
    candidates: Array<{ hostname: string; repositoryFullName: string }>,
  ): Promise<ReturnType<typeof Result.ok<Array<never>>>>;
  setIssueRepoLabel(
    issueId: string,
    labelName: string,
  ): Promise<ReturnType<typeof Result.ok<undefined>>>;
}

function createLinear(calls: Call[]): LinearService {
  const state: IssueState = {
    id: "state-1",
    name: "Todo",
    type: "unstarted",
  };

  const linear: ExtendedLinearService = {
    postActivity: async (
      sessionId: string,
      content: ActivityContent,
      ephemeral?: boolean,
    ) => {
      calls.push({ sessionId, content, ephemeral });
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
        identifier: "CODE-216",
        title: "t",
        url: "https://linear.app",
      }),
    getIssueLabels: async () => Result.ok([]),
    getIssueAttachments: async () => Result.ok([]),
    getIssueRepositorySuggestions: async () => Result.ok([]),
    setIssueRepoLabel: async () => Result.ok(undefined),
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () => Result.ok(state),
  };

  return linear;
}

async function seedStore(workdir: string): Promise<void> {
  await mkdir(join(TEST_STATE_ROOT, "auth"), { recursive: true });
  await mkdir(join(TEST_STATE_ROOT, "session"), { recursive: true });
  await mkdir(join(TEST_STATE_ROOT, "session-by-opencode"), {
    recursive: true,
  });
  await Bun.write(
    join(TEST_STATE_ROOT, "auth", "org-1.json"),
    JSON.stringify({
      organizationId: "org-1",
      accessToken: "token-1",
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshToken: "refresh-1",
      appId: "app-1",
      installedAt: new Date().toISOString(),
    }),
  );
  await Bun.write(
    join(TEST_STATE_ROOT, "session", "lin-1.json"),
    JSON.stringify({
      opencodeSessionId: "oc-1",
      linearSessionId: "lin-1",
      organizationId: "org-1",
      issueId: "CODE-216",
      branchName: "fix/code-216",
      workdir,
      lastActivityTime: Date.now(),
    }),
  );
  await Bun.write(
    join(TEST_STATE_ROOT, "session-by-opencode", "oc-1.json"),
    JSON.stringify({ linearSessionId: "lin-1" }),
  );
}

function reasoningPart(text: string, complete = true): ReasoningPart {
  return {
    type: "reasoning",
    id: "reasoning-1",
    sessionID: "oc-1",
    messageID: "msg-1",
    text,
    time: complete ? { start: 1, end: 2 } : { start: 1 },
  };
}

function textPart(text: string, complete = true): TextPart {
  return {
    type: "text",
    id: "text-1",
    sessionID: "oc-1",
    messageID: "msg-1",
    text,
    time: complete ? { start: 1, end: 2 } : { start: 1 },
  };
}

function partUpdated(part: ReasoningPart | TextPart): Event {
  return {
    type: "message.part.updated",
    properties: { part },
  };
}

function sessionIdle(): Event {
  return {
    type: "session.idle",
    properties: { sessionID: "oc-1" },
  };
}

describe("handleEvent", () => {
  const workdir = "/tmp/workdir";

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    setStateRootPath(TEST_STATE_ROOT);
    await seedStore(workdir);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("posts completed reasoning as thought", async () => {
    const calls: Call[] = [];

    await handleEvent(
      partUpdated(reasoningPart("Need inspect state flow.")),
      async () => [],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([
      {
        sessionId: "lin-1",
        content: { type: "thought", body: "Need inspect state flow." },
        ephemeral: true,
      },
    ]);
  });

  test("ignores text part updates", async () => {
    const calls: Call[] = [];

    await handleEvent(
      partUpdated(textPart("Final prose should wait.")),
      async () => [],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([]);
  });

  test("posts one final response on session idle", async () => {
    const calls: Call[] = [];
    const parts: Part[] = [textPart("Final answer")];

    await handleEvent(
      sessionIdle(),
      async () => [{ info: { role: "assistant" }, parts }],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([
      {
        sessionId: "lin-1",
        content: { type: "response", body: "Final answer" },
        ephemeral: false,
      },
    ]);
  });

  test("ignores late text after final response", async () => {
    const calls: Call[] = [];
    const parts: Part[] = [textPart("Final answer")];

    await handleEvent(
      sessionIdle(),
      async () => [{ info: { role: "assistant" }, parts }],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    await handleEvent(
      partUpdated(textPart("late text")),
      async () => [],
      async () => "token-1",
      () => createLinear(calls),
      () => {},
    );

    expect(calls).toEqual([
      {
        sessionId: "lin-1",
        content: { type: "response", body: "Final answer" },
        ephemeral: false,
      },
    ]);
  });
});
