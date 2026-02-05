import { describe, test, expect } from "bun:test";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import {
  processQuestionAsked,
  processQuestionFromTool,
} from "../../src/handlers/QuestionHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

function buildToolPart(input: Record<string, unknown>): ToolPart {
  return {
    id: "part-1",
    sessionID: "opencode-456",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "mcp_question",
    state: {
      status: "running",
      input,
      time: { start: Date.now() },
    },
  };
}

describe("processQuestionAsked", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
    issueId: "CODE-123",
  };

  test("should return elicitation actions and pending question", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Which option do you prefer?",
          header: "Preference",
          options: [
            { label: "Option A", description: "First option" },
            { label: "Option B", description: "Second option" },
          ],
          multiple: false,
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    // Should have elicitation action
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postElicitation",
      sessionId: "linear-123",
      body: "**Preference**\n\nWhich option do you prefer?\n\n- **Option A**: First option\n- **Option B**: Second option",
      signal: "select",
      metadata: {
        options: [{ value: "Option A" }, { value: "Option B" }],
      },
    });

    // Should have pending question
    expect(result.pendingQuestion).toMatchObject({
      requestId: "question-1",
      opencodeSessionId: "opencode-456",
      linearSessionId: "linear-123",
      workdir: "/workdir",
      questions: [
        {
          question: "Which option do you prefer?",
          header: "Preference",
          options: [
            { label: "Option A", description: "First option" },
            { label: "Option B", description: "Second option" },
          ],
          multiple: false,
        },
      ],
      answers: [null],
    });
    expect(result.pendingQuestion?.createdAt).toBeGreaterThan(0);
  });

  test("should handle multiple questions", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Question 1?",
          header: "Q1",
          options: [{ label: "A", description: "Option A" }],
        },
        {
          question: "Question 2?",
          header: "Q2",
          options: [{ label: "B", description: "Option B" }],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    // Should have 2 elicitation actions
    expect(result.actions).toHaveLength(2);

    // Should have 2 unanswered slots
    expect(result.pendingQuestion?.answers).toEqual([null, null]);
  });

  test("should skip events for other sessions", () => {
    const properties = {
      id: "question-1",
      sessionID: "other-session",
      questions: [
        {
          question: "Question?",
          header: "Q",
          options: [{ label: "A", description: "Option A" }],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    // No actions, no pending question
    expect(result.actions).toHaveLength(0);
    expect(result.pendingQuestion).toBeUndefined();
  });

  test("should handle null workdir", () => {
    const ctxNoWorkdir = {
      linearSessionId: "linear-123",
      opencodeSessionId: "opencode-456",
      workdir: null,
      issueId: "CODE-123",
    };

    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Question?",
          header: "Q",
          options: [{ label: "A", description: "Option A" }],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctxNoWorkdir);

    // Should have empty string for workdir
    expect(result.pendingQuestion?.workdir).toBe("");
  });

  test("should handle multiple selection questions", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Select all that apply:",
          header: "Multi",
          options: [
            { label: "Option A", description: "First option" },
            { label: "Option B", description: "Second option" },
            { label: "Option C", description: "Third option" },
          ],
          multiple: true,
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.pendingQuestion?.questions[0]?.multiple).toBe(true);
    expect(result.actions[0]).toMatchObject({
      metadata: {
        options: [
          { value: "Option A" },
          { value: "Option B" },
          { value: "Option C" },
        ],
      },
    });
  });

  test("should handle questions with empty options", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "What should we do?",
          header: "Action",
          options: [],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      content: {
        type: "elicitation",
        body: "**Action**\n\nWhat should we do?",
      },
    });
    expect(result.pendingQuestion?.questions[0]?.options).toHaveLength(0);
  });

  test("should format elicitation body with markdown", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Choose deployment target:",
          header: "Deploy",
          options: [
            { label: "Production", description: "Deploy to prod environment" },
            { label: "Staging", description: "Deploy to staging environment" },
          ],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.actions[0]).toMatchObject({
      body: "**Deploy**\n\nChoose deployment target:\n\n- **Production**: Deploy to prod environment\n- **Staging**: Deploy to staging environment",
    });
  });

  test("should use 'select' signal for all questions", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Q1?",
          header: "H1",
          options: [{ label: "A", description: "Opt A" }],
        },
        {
          question: "Q2?",
          header: "H2",
          options: [{ label: "B", description: "Opt B" }],
          multiple: true,
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.actions[0]).toMatchObject({ signal: "select" });
    expect(result.actions[1]).toMatchObject({ signal: "select" });
  });

  test("should store all question info in pending question", () => {
    const properties = {
      id: "question-123",
      sessionID: "opencode-456",
      questions: [
        {
          question: "First question?",
          header: "Q1",
          options: [{ label: "Yes", description: "Affirm" }],
          multiple: false,
        },
        {
          question: "Second question?",
          header: "Q2",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
          multiple: true,
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.pendingQuestion).toMatchObject({
      requestId: "question-123",
      opencodeSessionId: "opencode-456",
      linearSessionId: "linear-123",
      workdir: "/workdir",
      questions: [
        {
          question: "First question?",
          header: "Q1",
          options: [{ label: "Yes", description: "Affirm" }],
          multiple: false,
        },
        {
          question: "Second question?",
          header: "Q2",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
          multiple: true,
        },
      ],
      answers: [null, null],
    });
  });

  test("should handle empty questions array", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.actions).toHaveLength(0);
    expect(result.pendingQuestion).toMatchObject({
      questions: [],
      answers: [],
    });
  });

  test("should preserve special characters in question text", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Use `const` or `let`? What about <T> generics?",
          header: "Code",
          options: [
            { label: "const", description: "Immutable binding" },
            { label: "let", description: "Mutable binding" },
          ],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    expect(result.actions[0]).toMatchObject({
      body: "**Code**\n\nUse `const` or `let`? What about <T> generics?\n\n- **const**: Immutable binding\n- **let**: Mutable binding",
    });
  });

  test("should set createdAt timestamp", () => {
    const before = Date.now();

    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Q?",
          header: "H",
          options: [{ label: "A", description: "Opt" }],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    const after = Date.now();

    expect(result.pendingQuestion?.createdAt).toBeGreaterThanOrEqual(before);
    expect(result.pendingQuestion?.createdAt).toBeLessThanOrEqual(after);
  });

  test("should handle undefined multiple flag", () => {
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Question?",
          header: "Q",
          options: [{ label: "A", description: "Option A" }],
          // multiple is undefined
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    // undefined should be preserved
    expect(result.pendingQuestion?.questions[0]?.multiple).toBeUndefined();
  });

  test("should handle long option descriptions", () => {
    const longDescription = "D".repeat(500);
    const properties = {
      id: "question-1",
      sessionID: "opencode-456",
      questions: [
        {
          question: "Choose?",
          header: "Q",
          options: [{ label: "Long", description: longDescription }],
        },
      ],
    };

    const result = processQuestionAsked(properties, ctx);

    // Should include full description
    expect(result.actions[0]).toMatchObject({
      body: `**Q**\n\nChoose?\n\n- **Long**: ${longDescription}`,
    });
  });
});

describe("processQuestionFromTool", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
    issueId: "CODE-123",
  };

  test("should post elicitation for running question tool", () => {
    const part = buildToolPart({
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "Option A" }],
        },
      ],
    });

    const result = processQuestionFromTool(
      part,
      createInitialHandlerState(),
      ctx,
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postElicitation",
      body: "**Choice**\n\nPick one",
      metadata: { options: [{ value: "A" }] },
    });
    expect(result.pendingQuestion?.requestId).toBe("call-1");
    expect(result.state.postedQuestionElicitations.has("call-1")).toBe(true);
  });

  test("should deduplicate question tool elicitations", () => {
    const part = buildToolPart({
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "Option A" }],
        },
      ],
    });

    const first = processQuestionFromTool(
      part,
      createInitialHandlerState(),
      ctx,
    );
    const second = processQuestionFromTool(part, first.state, ctx);

    expect(first.actions).toHaveLength(1);
    expect(second.actions).toHaveLength(0);
    expect(second.pendingQuestion).toBeUndefined();
  });

  test("should post activity when options are missing", () => {
    const part = buildToolPart({
      questions: [
        {
          question: "Any thoughts?",
          header: "Note",
          options: [],
        },
      ],
    });

    const result = processQuestionFromTool(
      part,
      createInitialHandlerState(),
      ctx,
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      content: {
        type: "elicitation",
        body: "**Note**\n\nAny thoughts?",
      },
    });
  });

  test("should ignore non-question tools", () => {
    const part: ToolPart = {
      id: "part-2",
      sessionID: "opencode-456",
      messageID: "message-2",
      type: "tool",
      callID: "call-2",
      tool: "read",
      state: {
        status: "running",
        input: { filePath: "foo" },
        time: { start: Date.now() },
      },
    };

    const result = processQuestionFromTool(
      part,
      createInitialHandlerState(),
      ctx,
    );

    expect(result.actions).toHaveLength(0);
    expect(result.pendingQuestion).toBeUndefined();
  });
});
