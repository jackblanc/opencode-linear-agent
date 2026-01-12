import { describe, test, expect } from "bun:test";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import {
  processToolPart,
  getToolActionName,
  extractToolParameter,
} from "../../src/handlers/ToolHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

describe("getToolActionName", () => {
  test("should return present tense for running tools", () => {
    expect(getToolActionName("read", false)).toBe("Reading");
    expect(getToolActionName("edit", false)).toBe("Editing");
    expect(getToolActionName("write", false)).toBe("Creating");
    expect(getToolActionName("bash", false)).toBe("Running");
  });

  test("should return past tense for completed tools", () => {
    expect(getToolActionName("read", true)).toBe("Read");
    expect(getToolActionName("edit", true)).toBe("Edited");
    expect(getToolActionName("write", true)).toBe("Created");
    expect(getToolActionName("bash", true)).toBe("Ran");
  });

  test("should handle unknown tools", () => {
    expect(getToolActionName("custom", false)).toBe("Customing");
    expect(getToolActionName("custom", true)).toBe("Custom");
  });
});

describe("extractToolParameter", () => {
  test("should extract filePath for read/edit/write", () => {
    expect(
      extractToolParameter("read", { filePath: "/path/to/file.ts" }, null),
    ).toBe("/path/to/file.ts");
    expect(
      extractToolParameter("edit", { filePath: "/path/to/file.ts" }, null),
    ).toBe("/path/to/file.ts");
    expect(
      extractToolParameter("write", { filePath: "/path/to/file.ts" }, null),
    ).toBe("/path/to/file.ts");
  });

  test("should make paths relative to workdir", () => {
    expect(
      extractToolParameter(
        "read",
        { filePath: "/workdir/src/file.ts" },
        "/workdir",
      ),
    ).toBe("src/file.ts");
  });

  test("should extract command for bash", () => {
    expect(extractToolParameter("bash", { command: "npm install" }, null)).toBe(
      "npm install",
    );
  });

  test("should extract pattern for glob/grep", () => {
    expect(extractToolParameter("glob", { pattern: "**/*.ts" }, null)).toBe(
      "**/*.ts",
    );
    expect(extractToolParameter("grep", { pattern: "TODO" }, null)).toBe(
      "TODO",
    );
  });

  test("should extract description for task", () => {
    expect(
      extractToolParameter("task", { description: "Fix the bug" }, null),
    ).toBe("Fix the bug");
  });
});

describe("processToolPart", () => {
  const ctx = {
    linearSessionId: "linear-123",
    workdir: "/workdir",
  };

  const now = Date.now();

  test("should return postActivity action for running tool", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "read",
      state: {
        status: "running",
        input: { filePath: "/workdir/src/file.ts" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    // State should have tool added to running set
    expect(result.state.runningTools.has("tool-1")).toBe(true);

    // Should have action activity
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: {
        type: "action",
        action: "Reading",
        parameter: "src/file.ts",
      },
      ephemeral: true,
    });
  });

  test("should include thought for bash git commands", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "git push origin main" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    // Should have thought + action
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: {
        type: "thought",
        body: "Pushing changes to remote...",
      },
      ephemeral: true,
    });
  });

  test("should not duplicate running state for same tool", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "read",
      state: {
        status: "running",
        input: { filePath: "/workdir/src/file.ts" },
        time: { start: now },
      },
    };

    // Start with tool already in running set
    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");

    const result = processToolPart(part, state, ctx);

    // State unchanged, no actions
    expect(result.state.runningTools.has("tool-1")).toBe(true);
    expect(result.actions).toHaveLength(0);
  });

  test("should return completed action and remove from running set", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workdir/src/file.ts" },
        output: "File contents here",
        title: "Read file",
        metadata: {},
        time: { start: now, end: now + 100 },
      },
    };

    // Start with tool in running set
    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");

    const result = processToolPart(part, state, ctx);

    // State should have tool removed from running set
    expect(result.state.runningTools.has("tool-1")).toBe(false);

    // Should have completed action activity (persistent)
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: {
        type: "action",
        action: "Read",
        parameter: "src/file.ts",
        result: "File contents here",
      },
      ephemeral: false,
    });
  });

  test("should return error action for failed tool", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "error",
        input: { command: "invalid-command" },
        error: "Command not found",
        time: { start: now, end: now + 100 },
      },
    };

    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");

    const result = processToolPart(part, state, ctx);

    // State should have tool removed from running set
    expect(result.state.runningTools.has("tool-1")).toBe(false);

    // Should have error action activity
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "postActivity",
      sessionId: "linear-123",
      content: {
        type: "action",
        action: "Ran",
        parameter: "invalid-command",
        result: "Error: Command not found",
      },
      ephemeral: false,
    });
  });

  test("should not mutate original state", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "read",
      state: {
        status: "running",
        input: { filePath: "/workdir/src/file.ts" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const originalRunningTools = new Set(state.runningTools);

    processToolPart(part, state, ctx);

    // Original state should be unchanged
    expect(state.runningTools).toEqual(originalRunningTools);
  });
});
