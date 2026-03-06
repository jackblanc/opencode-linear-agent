import { describe, test, expect } from "bun:test";
import { Result } from "better-result";
import { LinearEventProcessor } from "../src/LinearEventProcessor";
import type { PendingQuestion } from "../src/session/SessionRepository";

function createPendingQuestion(): PendingQuestion {
  return {
    requestId: "qst-1",
    opencodeSessionId: "opencode-1",
    linearSessionId: "linear-1",
    workdir: "/tmp/workdir",
    issueId: "CODE-1",
    questions: [
      {
        question: "What next?",
        header: "Choice",
        options: [
          {
            label: "Ship now",
            description: "Merge immediately",
            value: "Merge immediately",
            aliases: ["Ship now", "Merge immediately"],
          },
          {
            label: "Update docs",
            description: "Docs only",
            value: "Docs only",
            aliases: ["Update docs", "Docs only"],
          },
        ],
      },
    ],
    answers: [null],
    createdAt: Date.now(),
  };
}

function createLog(): Record<string, unknown> {
  return {
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    tag: (): Record<string, unknown> => createLog(),
  };
}

function createProcessorHarness(pendingQuestion: PendingQuestion | null): {
  processor: Record<string, unknown>;
  replies: Array<Array<Array<string>>>;
  prompts: string[];
  deleted: string[];
} {
  const replies: Array<Array<Array<string>>> = [];
  const prompts: string[] = [];
  const deleted: string[] = [];

  const processor = Object.create(LinearEventProcessor.prototype);

  processor.opencode = {
    replyQuestion: async (
      _requestId: string,
      answers: Array<Array<string>>,
    ): Promise<Result<void, never>> => {
      replies.push(answers);
      return Result.ok(undefined);
    },
    replyPermission: async (): Promise<Result<void, never>> =>
      Result.ok(undefined),
    prompt: async (): Promise<Result<void, never>> => Result.ok(undefined),
  };

  processor.linear = {
    postError: async (): Promise<Result<void, never>> => Result.ok(undefined),
    postActivity: async (): Promise<Result<void, never>> =>
      Result.ok(undefined),
  };

  processor.sessions = {
    getPendingPermission: async (): Promise<null> => null,
    getPendingQuestion: async (): Promise<PendingQuestion | null> =>
      pendingQuestion,
    savePendingQuestion: async (): Promise<void> => undefined,
    deletePendingQuestion: async (sessionId: string): Promise<void> => {
      deleted.push(sessionId);
    },
    getPendingRepoSelection: async (): Promise<null> => null,
    savePendingRepoSelection: async (): Promise<void> => undefined,
    deletePendingRepoSelection: async (): Promise<void> => undefined,
    deletePendingPermission: async (): Promise<void> => undefined,
  };

  processor.promptBuilder = {
    buildFollowUpPrompt: (_event: unknown, userResponse: string): string =>
      `FOLLOWUP:${userResponse}`,
    buildFollowUpWithoutEvent: (userResponse: string): string =>
      `FOLLOWUP:${userResponse}`,
  };

  processor.config = { organizationId: "org-1" };

  processor.executePrompt = async (
    _opencodeSessionId: string,
    _linearSessionId: string,
    _workdir: string,
    prompt: string,
  ): Promise<void> => {
    prompts.push(prompt);
  };

  return { processor, replies, prompts, deleted };
}

async function callPrivate(
  processor: Record<string, unknown>,
  method: string,
  args: unknown[],
): Promise<void> {
  const fn = Reflect.get(processor, method);
  if (typeof fn !== "function") {
    throw new Error(`${method} missing`);
  }
  await fn.call(processor, ...args);
}

describe("LinearEventProcessor prompted handling", () => {
  test("maps subtitle replies to canonical option label", async () => {
    const harness = createProcessorHarness(createPendingQuestion());

    await callPrivate(harness.processor, "handleQuestionResponse", [
      createPendingQuestion(),
      "Merge immediately",
      "opencode-1",
      "linear-1",
      "/tmp/workdir",
      "build",
      undefined,
      createLog(),
    ]);

    expect(harness.replies).toEqual([[["Ship now"]]]);
    expect(harness.deleted).toEqual(["linear-1"]);
  });

  test("unmatched reply clears pending and sends follow-up", async () => {
    const harness = createProcessorHarness(createPendingQuestion());

    await callPrivate(harness.processor, "handleQuestionResponse", [
      createPendingQuestion(),
      "Do something else",
      "opencode-1",
      "linear-1",
      "/tmp/workdir",
      "build",
      undefined,
      createLog(),
    ]);

    expect(harness.replies).toEqual([]);
    expect(harness.deleted).toEqual(["linear-1"]);
    expect(harness.prompts[0]).toContain("FOLLOWUP:Do something else");
  });

  test("prompted flow reads top-level activity body before nested fields", async () => {
    const harness = createProcessorHarness(null);

    await callPrivate(harness.processor, "handlePrompted", [
      {
        agentActivity: {
          body: "Top level body",
          content: { body: "Nested body" },
        },
        promptContext: "Prompt context",
      },
      "opencode-1",
      "linear-1",
      "/tmp/workdir",
      "build",
      undefined,
      createLog(),
    ]);

    expect(harness.prompts[0]).toContain("FOLLOWUP:Top level body");
  });
});
