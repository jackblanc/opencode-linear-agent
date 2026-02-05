import { describe, test, expect } from "bun:test";
import { processQuestionFromTool } from "../../src/handlers/QuestionHandler";

describe("processQuestionFromTool", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
    issueId: "CODE-123",
  };

  test("should post elicitation for question tool with options", () => {
    const args = {
      questions: [
        {
          question: "Which option?",
          header: "Choice",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
        },
      ],
    };

    const result = processQuestionFromTool("call-1", args, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postElicitation",
      sessionId: "linear-123",
      signal: "select",
      metadata: {
        options: [{ value: "A" }, { value: "B" }],
      },
    });
    expect(result.pendingQuestion).toBeDefined();
    expect(result.pendingQuestion?.requestId).toBe("call-1");
  });

  test("should post activity for question tool without options", () => {
    const args = {
      questions: [{ question: "What should we do?" }],
    };

    const result = processQuestionFromTool("call-2", args, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "elicitation", body: "What should we do?" },
    });
  });

  test("should return empty for args with empty questions array", () => {
    const result = processQuestionFromTool("call-1", { questions: [] }, ctx);

    expect(result.actions).toHaveLength(0);
  });

  test("should return empty for args with no questions field", () => {
    const result = processQuestionFromTool("call-1", {}, ctx);

    expect(result.actions).toHaveLength(0);
  });

  test("should filter out questions without question text", () => {
    const args = {
      questions: [
        { question: "", options: [{ label: "A" }] },
        { question: "Valid?", options: [{ label: "B" }] },
      ],
    };

    const result = processQuestionFromTool("call-1", args, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.pendingQuestion?.questions).toHaveLength(1);
    expect(result.pendingQuestion?.questions[0]?.question).toBe("Valid?");
  });

  test("should include header in body when present", () => {
    const args = {
      questions: [
        {
          question: "Pick one",
          header: "Selection",
          options: [{ label: "A" }],
        },
      ],
    };

    const result = processQuestionFromTool("call-1", args, ctx);

    expect(result.actions[0]).toMatchObject({
      body: "**Selection**\n\nPick one",
    });
  });

  test("should handle null workdir in context", () => {
    const ctxNoWorkdir = { ...ctx, workdir: null };
    const args = {
      questions: [{ question: "Q?", options: [{ label: "A" }] }],
    };

    const result = processQuestionFromTool("call-1", args, ctxNoWorkdir);

    expect(result.pendingQuestion?.workdir).toBe("");
  });
});
