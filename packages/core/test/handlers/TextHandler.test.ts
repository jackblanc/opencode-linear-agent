import { describe, test, expect } from "bun:test";
import type { TextPart } from "@opencode-ai/sdk/v2";
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

    // No change, no actions
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

    // No change, no actions
    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should post thought activity for complete text", () => {
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

    // State should have text part marked as sent
    expect(result.state.sentTextParts.has("text-1")).toBe(true);
    // Should NOT mark final response as posted (that happens when message completes)
    expect(result.state.postedFinalResponse).toBe(false);
    // Should track last text part for this message
    expect(result.state.lastTextParts.get("msg-1")).toEqual({
      partId: "text-1",
      text: "Hello, world!",
    });

    // Should have thought activity (not response - response is posted when message completes)
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: "Hello, world!" },
      ephemeral: true,
    });
  });

  test("should not duplicate already sent text parts", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Hello, world!",
      time: { start: now, end: now + 100 },
    };

    // Start with text already sent
    const state = createInitialHandlerState();
    state.sentTextParts.add("text-1");

    const result = processTextPart(part, state, ctx);

    // No change, no actions
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
    const originalPostedFinalResponse = state.postedFinalResponse;

    processTextPart(part, state, ctx);

    // Original state should be unchanged
    expect(state.sentTextParts).toEqual(originalSentTextParts);
    expect(state.postedFinalResponse).toBe(originalPostedFinalResponse);
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

  test("should handle text with leading/trailing whitespace", () => {
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

    // Should post as thought, and trim the text for storage
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: "  Hello, world!  " },
      ephemeral: true,
    });
    // Last text part should be trimmed
    expect(result.state.lastTextParts.get("msg-1")?.text).toBe("Hello, world!");
  });

  test("should handle multi-line text", () => {
    const multiLineText = "Line 1\nLine 2\n\nLine 4";
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: multiLineText,
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: multiLineText },
      ephemeral: true,
    });
  });

  test("should handle very long text", () => {
    const longText = "A".repeat(10000);
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: longText,
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    // Should pass through the full text (truncation is Linear's responsibility)
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: longText },
      ephemeral: true,
    });
  });

  test("should process multiple text parts sequentially", () => {
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

    expect(result1.state.sentTextParts.has("text-1")).toBe(true);
    expect(result2.state.sentTextParts.has("text-1")).toBe(true);
    expect(result2.state.sentTextParts.has("text-2")).toBe(true);
    expect(result2.actions).toHaveLength(1);
  });

  test("should handle time object with only start time", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "In progress...",
      time: { start: now },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    // Should not process incomplete text
    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
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

    // Should return exact same state object (not a copy)
    expect(result.state).toBe(state);
  });

  test("should handle text with special characters", () => {
    const specialText =
      "Code: `const x = 1;` and emoji: 🎉 and unicode: 日本語";
    const part: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: specialText,
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processTextPart(part, state, ctx);

    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "thought", body: specialText },
      ephemeral: true,
    });
  });

  test("should update lastTextParts for each message", () => {
    const part1: TextPart = {
      type: "text",
      id: "text-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "First text",
      time: { start: now, end: now + 100 },
    };

    const part2: TextPart = {
      type: "text",
      id: "text-2",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Second text",
      time: { start: now + 100, end: now + 200 },
    };

    const state = createInitialHandlerState();
    const result1 = processTextPart(part1, state, ctx);
    const result2 = processTextPart(part2, result1.state, ctx);

    // Last text part for msg-1 should be the second one
    expect(result2.state.lastTextParts.get("msg-1")).toEqual({
      partId: "text-2",
      text: "Second text",
    });
  });
});

describe("processMessageCompleted", () => {
  const ctx = {
    linearSessionId: "linear-123",
  };

  test("should post response when message completes with text", () => {
    const state = createInitialHandlerState();
    state.lastTextParts.set("msg-1", {
      partId: "text-1",
      text: "Hello, world!",
    });

    const result = processMessageCompleted("msg-1", state, ctx);

    expect(result.state.postedFinalResponse).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "response", body: "Hello, world!" },
      ephemeral: false,
    });
  });

  test("should not post response if no last text part", () => {
    const state = createInitialHandlerState();

    const result = processMessageCompleted("msg-1", state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should not post response if already posted", () => {
    const state = createInitialHandlerState();
    state.lastTextParts.set("msg-1", {
      partId: "text-1",
      text: "Hello, world!",
    });
    state.postedFinalResponse = true;

    const result = processMessageCompleted("msg-1", state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should not mutate original state", () => {
    const state = createInitialHandlerState();
    state.lastTextParts.set("msg-1", {
      partId: "text-1",
      text: "Hello, world!",
    });
    const originalPostedFinalResponse = state.postedFinalResponse;

    processMessageCompleted("msg-1", state, ctx);

    expect(state.postedFinalResponse).toBe(originalPostedFinalResponse);
  });
});
