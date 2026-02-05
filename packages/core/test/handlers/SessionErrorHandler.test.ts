import { describe, expect, test } from "bun:test";
import { processSessionError } from "../../src/handlers/SessionErrorHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("processSessionError", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
  };

  test("should post error activity for matching session", () => {
    const properties = {
      sessionID: "opencode-456",
      error: { data: { message: "Something went wrong" } },
    };

    const result = processSessionError(
      properties,
      createInitialHandlerState(),
      ctx,
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      content: { type: "error", body: "**Error:** Something went wrong" },
    });
    expect(result.state.postedError).toBe(true);
  });

  test("should ignore errors for other sessions", () => {
    const properties = {
      sessionID: "other-session",
      error: { data: { message: "Ignore me" } },
    };

    const result = processSessionError(
      properties,
      createInitialHandlerState(),
      ctx,
    );

    expect(result.actions).toHaveLength(0);
    expect(result.state.postedError).toBe(false);
  });

  test("should deduplicate error posting", () => {
    const properties = {
      sessionID: "opencode-456",
      error: { name: "APIError" },
    };

    const first = processSessionError(
      properties,
      createInitialHandlerState(),
      ctx,
    );
    const second = processSessionError(properties, first.state, ctx);

    expect(first.actions).toHaveLength(1);
    expect(second.actions).toHaveLength(0);
  });
});
