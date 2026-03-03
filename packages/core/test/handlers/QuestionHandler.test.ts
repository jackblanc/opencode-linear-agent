import { describe, test, expect } from "bun:test";
import { processQuestionAsked } from "../../src/handlers/QuestionHandler";

describe("processQuestionAsked", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
    issueId: "CODE-123",
  };

  test("should post elicitation for question with options", () => {
    const questions = [
      {
        question: "Which option?",
        header: "Choice",
        options: [
          { label: "A", description: "Option A" },
          { label: "B", description: "Option B" },
        ],
      },
    ];

    const result = processQuestionAsked("qst_abc123", questions, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postElicitation",
      sessionId: "linear-123",
      body: "**Choice**\n\nWhich option?\n\nOptions:\n- A - Option A\n- B - Option B",
      signal: "select",
      metadata: {
        options: [
          { label: "A", value: "Option A" },
          { label: "B", value: "Option B" },
        ],
      },
    });
    expect(result.pendingQuestion).toBeDefined();
    expect(result.pendingQuestion?.requestId).toBe("qst_abc123");
  });

  test("should post activity for question without options", () => {
    const questions = [
      { question: "What should we do?", header: "", options: [] },
    ];

    const result = processQuestionAsked("qst_def456", questions, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "elicitation", body: "What should we do?" },
    });
  });

  test("should return empty for empty questions array", () => {
    const result = processQuestionAsked("qst_123", [], ctx);

    expect(result.actions).toHaveLength(0);
  });

  test("should filter out questions without question text", () => {
    const questions = [
      { question: "", header: "", options: [{ label: "A", description: "" }] },
      {
        question: "Valid?",
        header: "",
        options: [{ label: "B", description: "" }],
      },
    ];

    const result = processQuestionAsked("qst_123", questions, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.pendingQuestion?.questions).toHaveLength(1);
    expect(result.pendingQuestion?.questions[0]?.question).toBe("Valid?");
  });

  test("should include header in body when present", () => {
    const questions = [
      {
        question: "Pick one",
        header: "Selection",
        options: [{ label: "A", description: "" }],
      },
    ];

    const result = processQuestionAsked("qst_123", questions, ctx);

    expect(result.actions[0]).toMatchObject({
      body: "**Selection**\n\nPick one\n\nOptions:\n- A",
    });
  });

  test("should trim description and keep clean option context", () => {
    const questions = [
      {
        question: "Pick one",
        header: "",
        options: [
          { label: "A", description: "  Option A  " },
          { label: "B", description: "   " },
        ],
      },
    ];

    const result = processQuestionAsked("qst_123", questions, ctx);

    expect(result.actions[0]).toMatchObject({
      body: "Pick one\n\nOptions:\n- A - Option A\n- B",
      metadata: {
        options: [
          { label: "A", value: "Option A" },
          { label: "B", value: "B" },
        ],
      },
    });
    expect(result.pendingQuestion?.questions[0]?.options).toEqual([
      {
        label: "A",
        description: "Option A",
        value: "Option A",
        aliases: ["A", "Option A"],
      },
      {
        label: "B",
        description: "",
        value: "B",
        aliases: ["B"],
      },
    ]);
  });

  test("should handle null workdir in context", () => {
    const ctxNoWorkdir = { ...ctx, workdir: null };
    const questions = [
      {
        question: "Q?",
        header: "",
        options: [{ label: "A", description: "" }],
      },
    ];

    const result = processQuestionAsked("qst_123", questions, ctxNoWorkdir);

    expect(result.pendingQuestion?.workdir).toBe("");
  });

  test("should use OpenCode question ID as requestId", () => {
    const questions = [{ question: "Test?", header: "", options: [] }];

    const result = processQuestionAsked("qst_xyz789", questions, ctx);

    expect(result.pendingQuestion?.requestId).toBe("qst_xyz789");
  });
});
