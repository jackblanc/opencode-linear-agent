import { describe, test, expect } from "bun:test";
import { processPermissionAsked } from "../../src/handlers/PermissionHandler";

describe("processPermissionAsked", () => {
  const ctx = {
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
  };

  test("should return replyPermission action with always", () => {
    const properties = {
      id: "perm-1",
      sessionID: "opencode-456",
      permission: "write_file",
    };

    const actions = processPermissionAsked(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "replyPermission",
      requestId: "perm-1",
      reply: "always",
      directory: "/workdir",
    });
  });

  test("should skip events for other sessions", () => {
    const properties = {
      id: "perm-1",
      sessionID: "other-session",
      permission: "write_file",
    };

    const actions = processPermissionAsked(properties, ctx);

    expect(actions).toHaveLength(0);
  });

  test("should handle null workdir", () => {
    const ctxNoWorkdir = {
      opencodeSessionId: "opencode-456",
      workdir: null,
    };

    const properties = {
      id: "perm-1",
      sessionID: "opencode-456",
      permission: "write_file",
    };

    const actions = processPermissionAsked(properties, ctxNoWorkdir);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "replyPermission",
      requestId: "perm-1",
      reply: "always",
      directory: undefined,
    });
  });
});
