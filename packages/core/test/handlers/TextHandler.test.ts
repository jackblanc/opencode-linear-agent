import { describe, test, expect } from "bun:test";
import { processSessionIdle } from "../../src/handlers/TextHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("processSessionIdle", () => {
  const ctx = {
    linearSessionId: "linear-123",
  };

  test("posts final response from provided text", () => {
    const state = createInitialHandlerState();

    const result = processSessionIdle("Hello, world!", state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "response", body: "Hello, world!" },
      ephemeral: false,
    });
  });

  test("skips empty response text", () => {
    const state = createInitialHandlerState();

    const result = processSessionIdle("   ", state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("does not mutate original state", () => {
    const state = createInitialHandlerState();

    processSessionIdle("Hello, world!", state, ctx);

    expect(state).toEqual(createInitialHandlerState());
  });
});
