import { describe, test, expect } from "bun:test";
import { processQuestionAsked } from "../../src/handlers/QuestionHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("processQuestionAsked", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
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

    const state = createInitialHandlerState();
    const result = processQuestionAsked(properties, state, ctx);

    // Should have elicitation action
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postElicitation",
      sessionId: "linear-123",
      body: "Which option do you prefer?\n\n- **Option A**: First option\n- **Option B**: Second option",
      signal: "select",
      metadata: {
        options: [{ value: "Option A" }, { value: "Option B" }],
      },
    });

    // Should have pending question
    expect(result.pendingQuestion).toMatchObject({
      requestId: "question-1",
      opcodeSessionId: "opencode-456",
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

    const state = createInitialHandlerState();
    const result = processQuestionAsked(properties, state, ctx);

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

    const state = createInitialHandlerState();
    const result = processQuestionAsked(properties, state, ctx);

    // No actions, no pending question
    expect(result.actions).toHaveLength(0);
    expect(result.pendingQuestion).toBeUndefined();
  });

  test("should handle null workdir", () => {
    const ctxNoWorkdir = {
      linearSessionId: "linear-123",
      opencodeSessionId: "opencode-456",
      workdir: null,
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

    const state = createInitialHandlerState();
    const result = processQuestionAsked(properties, state, ctxNoWorkdir);

    // Should have empty string for workdir
    expect(result.pendingQuestion?.workdir).toBe("");
  });

  test("should not mutate handler state", () => {
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

    const state = createInitialHandlerState();
    const result = processQuestionAsked(properties, state, ctx);

    // State should be unchanged (returned same object)
    expect(result.state).toBe(state);
  });
});
