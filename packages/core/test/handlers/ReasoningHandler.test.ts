import { describe, test, expect } from "bun:test";
import type { ReasoningPart } from "@opencode-ai/sdk/v2";
import { processReasoningPart } from "../../src/handlers/ReasoningHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("processReasoningPart", () => {
  const ctx = {
    linearSessionId: "linear-123",
  };

  const now = Date.now();

  test("posts completed reasoning as ephemeral thought", () => {
    const part: ReasoningPart = {
      type: "reasoning",
      id: "reasoning-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Need inspect handler flow first.",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processReasoningPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toEqual([
      {
        type: "postActivity",
        sessionId: "linear-123",
        content: { type: "thought", body: "Need inspect handler flow first." },
        ephemeral: true,
      },
    ]);
  });

  test("trims reasoning before posting", () => {
    const part: ReasoningPart = {
      type: "reasoning",
      id: "reasoning-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "\n Need inspect handler flow first. \n",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processReasoningPart(part, state, ctx);

    expect(result.actions).toEqual([
      {
        type: "postActivity",
        sessionId: "linear-123",
        content: { type: "thought", body: "Need inspect handler flow first." },
        ephemeral: true,
      },
    ]);
  });

  test("skips incomplete reasoning", () => {
    const part: ReasoningPart = {
      type: "reasoning",
      id: "reasoning-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "Still thinking",
      time: { start: now },
    };

    const state = createInitialHandlerState();
    const result = processReasoningPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("skips empty reasoning", () => {
    const part: ReasoningPart = {
      type: "reasoning",
      id: "reasoning-1",
      sessionID: "session-1",
      messageID: "msg-1",
      text: "  ",
      time: { start: now, end: now + 100 },
    };

    const state = createInitialHandlerState();
    const result = processReasoningPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });
});
