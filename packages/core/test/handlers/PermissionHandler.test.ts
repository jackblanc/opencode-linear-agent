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

  test("should auto-approve bash execution permissions", () => {
    const properties = {
      id: "perm-1",
      sessionID: "opencode-456",
      permission: "bash_execute",
    };

    const actions = processPermissionAsked(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "replyPermission",
      reply: "always",
    });
  });

  test("should auto-approve mcp tool permissions", () => {
    const properties = {
      id: "perm-1",
      sessionID: "opencode-456",
      permission: "mcp_tool",
    };

    const actions = processPermissionAsked(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "replyPermission",
      reply: "always",
    });
  });

  test("should handle additional properties in event", () => {
    const properties = {
      id: "perm-1",
      sessionID: "opencode-456",
      permission: "write_file",
      filePath: "/path/to/file.ts",
      extra: "ignored",
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

  test("should handle empty workdir string", () => {
    const ctxEmptyWorkdir = {
      opencodeSessionId: "opencode-456",
      workdir: "",
    };

    const properties = {
      id: "perm-1",
      sessionID: "opencode-456",
      permission: "write_file",
    };

    const actions = processPermissionAsked(properties, ctxEmptyWorkdir);

    expect(actions).toHaveLength(1);
    // Empty string passes the ?? check, so it becomes ""
    expect(actions[0]).toEqual({
      type: "replyPermission",
      requestId: "perm-1",
      reply: "always",
      directory: "",
    });
  });

  test("should use the correct request ID from properties", () => {
    const properties1 = {
      id: "unique-id-123",
      sessionID: "opencode-456",
      permission: "write_file",
    };

    const properties2 = {
      id: "another-id-456",
      sessionID: "opencode-456",
      permission: "bash_execute",
    };

    const actions1 = processPermissionAsked(properties1, ctx);
    const actions2 = processPermissionAsked(properties2, ctx);

    expect(actions1[0]).toMatchObject({ requestId: "unique-id-123" });
    expect(actions2[0]).toMatchObject({ requestId: "another-id-456" });
  });

  test("should always reply with 'always' regardless of permission type", () => {
    const permissionTypes = [
      "write_file",
      "read_file",
      "bash_execute",
      "mcp_tool",
      "network_access",
      "unknown_permission",
    ];

    for (const permission of permissionTypes) {
      const properties = {
        id: `perm-${permission}`,
        sessionID: "opencode-456",
        permission,
      };

      const actions = processPermissionAsked(properties, ctx);

      expect(actions[0]).toMatchObject({
        reply: "always",
      });
    }
  });
});
