import { describe, test, expect } from "bun:test";
import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import { processPermissionAsked } from "../../src/handlers/PermissionHandler";
import type { PostElicitationAction, Action } from "../../src/actions/types";

function createPermissionRequest(
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "opencode-456",
    permission: "Bash",
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  };
}

function isPostElicitationAction(
  action: Action,
): action is PostElicitationAction {
  return action.type === "postElicitation";
}

describe("processPermissionAsked", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
    workdir: "/workdir",
    issueId: "CODE-123",
  };

  test("should return elicitation action and pending permission", () => {
    const properties = createPermissionRequest();

    const result = processPermissionAsked(properties, ctx);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postElicitation",
      sessionId: "linear-123",
      signal: "select",
    });
    expect(result.pendingPermission).toBeDefined();
    expect(result.pendingPermission?.requestId).toBe("perm-1");
    expect(result.pendingPermission?.permission).toBe("Bash");
  });

  test("should skip events for other sessions", () => {
    const properties = createPermissionRequest({
      sessionID: "other-session",
    });

    const result = processPermissionAsked(properties, ctx);

    expect(result.actions).toHaveLength(0);
    expect(result.pendingPermission).toBeUndefined();
  });

  test("should include patterns in elicitation body", () => {
    const properties = createPermissionRequest({
      patterns: ["/path/to/file.ts", "*.json"],
    });

    const result = processPermissionAsked(properties, ctx);

    expect(result.actions[0]).toMatchObject({
      type: "postElicitation",
    });
    const action = result.actions[0];
    if (action && isPostElicitationAction(action)) {
      expect(action.body).toContain("`/path/to/file.ts`");
      expect(action.body).toContain("`*.json`");
    } else {
      throw new Error("Expected postElicitation action");
    }
  });

  test("should include approval options in metadata", () => {
    const properties = createPermissionRequest();

    const result = processPermissionAsked(properties, ctx);

    const action = result.actions[0];
    if (action && isPostElicitationAction(action) && action.metadata) {
      const options = action.metadata;
      if ("options" in options && Array.isArray(options.options)) {
        const values = options.options.map((o) => o.value);
        expect(values).toContain("Approve");
        expect(values).toContain("Approve Always");
        expect(values).toContain("Reject");
      } else {
        throw new Error("Expected options in metadata");
      }
    } else {
      throw new Error("Expected postElicitation action with metadata");
    }
  });

  test("should store correct data in pending permission", () => {
    const properties = createPermissionRequest({
      id: "perm-unique",
      permission: "Edit",
      patterns: ["/src/**/*.ts"],
      metadata: { custom: "data" },
    });

    const result = processPermissionAsked(properties, ctx);

    expect(result.pendingPermission).toEqual({
      requestId: "perm-unique",
      opencodeSessionId: "opencode-456",
      linearSessionId: "linear-123",
      workdir: "/workdir",
      issueId: "CODE-123",
      permission: "Edit",
      patterns: ["/src/**/*.ts"],
      metadata: { custom: "data" },
      createdAt: expect.any(Number),
    });
  });

  test("should handle null workdir", () => {
    const ctxNoWorkdir = {
      linearSessionId: "linear-123",
      opencodeSessionId: "opencode-456",
      workdir: null,
      issueId: "CODE-123",
    };

    const properties = createPermissionRequest();

    const result = processPermissionAsked(properties, ctxNoWorkdir);

    expect(result.pendingPermission?.workdir).toBe("");
  });

  test("should handle different permission types", () => {
    const permissionTypes = ["Bash", "Write", "Edit", "Read"];

    for (const permission of permissionTypes) {
      const properties = createPermissionRequest({ permission });

      const result = processPermissionAsked(properties, ctx);

      expect(result.actions).toHaveLength(1);
      const action = result.actions[0];
      if (action && isPostElicitationAction(action)) {
        expect(action.body).toContain(`Permission Request: ${permission}`);
      } else {
        throw new Error("Expected postElicitation action");
      }
      expect(result.pendingPermission?.permission).toBe(permission);
    }
  });
});
