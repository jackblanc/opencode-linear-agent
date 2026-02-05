import { describe, test, expect } from "bun:test";
import { processSessionError } from "../../src/handlers/SessionErrorHandler";
import type { SessionErrorProperties } from "../../src/handlers/SessionErrorHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("processSessionError", () => {
  const ctx = { linearSessionId: "linear-123" };

  test("should post error activity with message from error.data.message", () => {
    const state = createInitialHandlerState();
    const props: SessionErrorProperties = {
      sessionID: "session-1",
      error: {
        name: "UnknownError",
        data: { message: "Something went wrong" },
      },
    };

    const result = processSessionError(props, state, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      sessionId: "linear-123",
      content: { type: "error", body: "**Error:** Something went wrong" },
      ephemeral: false,
    });
    expect(result.state.postedError).toBe(true);
  });

  test("should fall back to error.name when data.message is missing", () => {
    const state = createInitialHandlerState();
    const props: SessionErrorProperties = {
      sessionID: "session-1",
      error: { name: "ProviderAuthError" },
    };

    const result = processSessionError(props, state, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      content: { body: "**Error:** ProviderAuthError" },
    });
  });

  test("should use 'Unknown error' when error object has no name or message", () => {
    const state = createInitialHandlerState();
    const props: SessionErrorProperties = {
      sessionID: "session-1",
      error: {},
    };

    const result = processSessionError(props, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: { body: "**Error:** Unknown error" },
    });
  });

  test("should use 'Unknown error' when error is undefined", () => {
    const state = createInitialHandlerState();
    const props: SessionErrorProperties = {
      sessionID: "session-1",
    };

    const result = processSessionError(props, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: { body: "**Error:** Unknown error" },
    });
  });

  test("should deduplicate via postedError flag", () => {
    const state = createInitialHandlerState();
    const props: SessionErrorProperties = {
      sessionID: "session-1",
      error: { name: "UnknownError", data: { message: "Error 1" } },
    };

    const first = processSessionError(props, state, ctx);
    expect(first.actions).toHaveLength(1);
    expect(first.state.postedError).toBe(true);

    const second = processSessionError(
      {
        ...props,
        error: { name: "UnknownError", data: { message: "Error 2" } },
      },
      first.state,
      ctx,
    );
    expect(second.actions).toHaveLength(0);
    expect(second.state.postedError).toBe(true);
  });

  test("should not modify other state fields", () => {
    const state = {
      ...createInitialHandlerState(),
      runningTools: new Set(["tool-1"]),
      sentTextParts: new Set(["text-1"]),
    };
    const props: SessionErrorProperties = {
      sessionID: "session-1",
      error: { name: "UnknownError", data: { message: "err" } },
    };

    const result = processSessionError(props, state, ctx);

    expect(result.state.runningTools).toEqual(new Set(["tool-1"]));
    expect(result.state.sentTextParts).toEqual(new Set(["text-1"]));
  });
});
