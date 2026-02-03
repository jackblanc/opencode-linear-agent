import { describe, test, expect } from "bun:test";
import type { TextPart, AssistantMessage } from "@opencode-ai/sdk/v2";
import {
  processTextPart,
  processMessageCompleted,
} from "../../src/handlers/TextHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("processTextPart", () => {
  const ctx = {
    linearSessionId: "linear-123",
  };

  const now = Date.now();

  test("should skip empty text", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "   ",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should skip incomplete text parts (no end time)", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Hello, world!",
      time: { start: now },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should store text for message without posting", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Hello, world!",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    // State should have text part marked as processed
    expect(result.state.sentTextParts.has("text-1")).toBe(true);
    // Should store the text content for this message
    expect(result.state.lastTextByMessage.get("msg-1")).toBe("Hello, world!");
    // Should NOT set postedFinalResponse yet (that happens on message complete)
    expect(result.state.postedFinalResponse).toBe(false);
    // Should NOT post any activity - text is only posted as response when message completes
    expect(result.actions).toHaveLength(0);
  });

  test("should not duplicate already processed text parts", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Hello, world!",
      time: { start: now, end: now + 100 },
    };

    // Start with text already processed
    const state = createInitialHandlerState();
    state.sentTextParts.add("text-1");

    const result = processTextPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should not mutate original state", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Hello, world!",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const originalSentTextParts = new Set(state.sentTextParts);
    const originalLastTextByMessage = new Map(state.lastTextByMessage);

    processTextPart(part, state, ctx);

    // Original state should be unchanged
    expect(state.sentTextParts).toEqual(originalSentTextParts);
    expect(state.lastTextByMessage).toEqual(originalLastTextByMessage);
  });

  test("should overwrite previous text for same message", () => {
    const part1: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "First response",
      time: { start: now, end: now + 100 },
    };

    const part2: TextPart = {
      type: "text",
      id: "text-2",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Second response",
      time: { start: now + 100, end: now + 200 },
    };

    const state = createInitialHandlerState();
    const result1 = processTextPart(part1, state, ctx);
    const result2 = processTextPart(part2, result1.state, ctx);

    // Both should be marked as processed
    expect(result2.state.sentTextParts.has("text-1")).toBe(true);
    expect(result2.state.sentTextParts.has("text-2")).toBe(true);
    // Only the last text should be stored for the message
    expect(result2.state.lastTextByMessage.get("msg-1")).toBe(
      "Second response",
    );
    // Neither should post actions - text is only posted as response when message completes
    expect(result1.actions).toHaveLength(0);
    expect(result2.actions).toHaveLength(0);
  });
});

describe("processMessageCompleted", () => {
  const ctx = {
    linearSessionId: "linear-123",
  };

  const now = Date.now();

  function createAssistantMessage(
    overrides: Partial<AssistantMessage> = {},
  ): AssistantMessage {
    return {
      id: "msg-1",
      sessionID: "session-1",
      role: "assistant",
      time: { created: now },
      parentID: "parent-1",
      modelID: "claude-3",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...overrides,
    };
  }

  test("should post final response when message completes", () => {
    const message = createAssistantMessage({
      time: { created: now, completed: now + 1000 },
    });

    const state = createInitialHandlerState();
    state.lastTextByMessage.set("msg-1", "Final response text");

    const result = processMessageCompleted(message, state, ctx);

    // Should mark message as completed
    expect(result.state.completedMessages.has("msg-1")).toBe(true);
    // Should clear the text for this message
    expect(result.state.lastTextByMessage.has("msg-1")).toBe(false);
    // Should mark final response as posted
    expect(result.state.postedFinalResponse).toBe(true);
    // Should post response activity
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "response", body: "Final response text" },
      ephemeral: false,
    });
  });

  test("should skip if message not completed", () => {
    const message = createAssistantMessage();
    // No time.completed

    const state = createInitialHandlerState();
    state.lastTextByMessage.set("msg-1", "Some text");

    const result = processMessageCompleted(message, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should skip if message already processed", () => {
    const message = createAssistantMessage({
      time: { created: now, completed: now + 1000 },
    });

    const state = createInitialHandlerState();
    state.completedMessages.add("msg-1");
    state.lastTextByMessage.set("msg-1", "Some text");

    const result = processMessageCompleted(message, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should skip if final response already posted", () => {
    const message = createAssistantMessage({
      time: { created: now, completed: now + 1000 },
    });

    const state = createInitialHandlerState();
    state.postedFinalResponse = true;
    state.lastTextByMessage.set("msg-1", "Some text");

    const result = processMessageCompleted(message, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should mark completed but not post if no text for message", () => {
    const message = createAssistantMessage({
      time: { created: now, completed: now + 1000 },
    });

    const state = createInitialHandlerState();
    // No text stored for this message

    const result = processMessageCompleted(message, state, ctx);

    // Should mark message as completed
    expect(result.state.completedMessages.has("msg-1")).toBe(true);
    // Should NOT mark final response as posted (no text to post)
    expect(result.state.postedFinalResponse).toBe(false);
    // Should have no actions
    expect(result.actions).toHaveLength(0);
  });

  test("should not mutate original state", () => {
    const message = createAssistantMessage({
      time: { created: now, completed: now + 1000 },
    });

    const state = createInitialHandlerState();
    state.lastTextByMessage.set("msg-1", "Final response text");

    const originalCompletedMessages = new Set(state.completedMessages);
    const originalLastTextByMessage = new Map(state.lastTextByMessage);
    const originalPostedFinalResponse = state.postedFinalResponse;

    processMessageCompleted(message, state, ctx);

    expect(state.completedMessages).toEqual(originalCompletedMessages);
    expect(state.lastTextByMessage).toEqual(originalLastTextByMessage);
    expect(state.postedFinalResponse).toBe(originalPostedFinalResponse);
  });
});
