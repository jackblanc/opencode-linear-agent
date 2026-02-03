import { describe, test, expect } from "bun:test";
import type { TextPart } from "@opencode-ai/sdk/v2";
import {
  processTextPart,
  processSessionIdle,
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

  test("should post thought and store text for final response", () => {
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
    // Should store the text content for final response on idle
    expect(result.state.lastTextContent).toBe("Hello, world!");
    // Should NOT set postedFinalResponse yet (that happens on idle)
    expect(result.state.postedFinalResponse).toBe(false);
    // Should post thought activity for intermediate text
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: "Hello, world!" },
      ephemeral: false,
    });
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
    const originalLastTextContent = state.lastTextContent;

    processTextPart(part, state, ctx);

    // Original state should be unchanged
    expect(state.sentTextParts).toEqual(originalSentTextParts);
    expect(state.lastTextContent).toBe(originalLastTextContent);
  });

  test("should handle text with only whitespace characters", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "\t\n  \r\n",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should store and post text with leading/trailing whitespace", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "  Hello, world!  ",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    // Should store and post the text with whitespace
    expect(result.state.lastTextContent).toBe("  Hello, world!  ");
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: "  Hello, world!  " },
      ephemeral: false,
    });
  });

  test("should overwrite previous text content with new text and post each as thought", () => {
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

    // Both should be stored, but only last one persists for final response
    expect(result1.state.lastTextContent).toBe("First response");
    expect(result2.state.lastTextContent).toBe("Second response");
    expect(result2.state.sentTextParts.has("text-1")).toBe(true);
    expect(result2.state.sentTextParts.has("text-2")).toBe(true);

    // Each should post a thought action
    expect(result1.actions).toHaveLength(1);
    expect(result1.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: "First response" },
      ephemeral: false,
    });
    expect(result2.actions).toHaveLength(1);
    expect(result2.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: "Second response" },
      ephemeral: false,
    });
  });

  test("should return same state reference when no changes occur", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    expect(result.state).toBe(state);
  });
});

describe("processSessionIdle", () => {
  const ctx = {
    linearSessionId: "linear-123",
  };

  test("should post final response when session goes idle", () => {
    const state = createInitialHandlerState();
    state.lastTextContent = "Final response text";

    const result = processSessionIdle(state, ctx);

    // Should clear lastTextContent
    expect(result.state.lastTextContent).toBeNull();
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

  test("should not post anything if no text content", () => {
    const state = createInitialHandlerState();

    const result = processSessionIdle(state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should not post if final response already posted", () => {
    const state = createInitialHandlerState();
    state.lastTextContent = "Some text";
    state.postedFinalResponse = true;

    const result = processSessionIdle(state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should not mutate original state", () => {
    const state = createInitialHandlerState();
    state.lastTextContent = "Final response text";

    const originalLastTextContent = state.lastTextContent;
    const originalPostedFinalResponse = state.postedFinalResponse;

    processSessionIdle(state, ctx);

    expect(state.lastTextContent).toBe(originalLastTextContent);
    expect(state.postedFinalResponse).toBe(originalPostedFinalResponse);
  });
});
