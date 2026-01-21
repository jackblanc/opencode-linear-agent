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

  test("should return search tool names", () => {
    expect(getToolActionName("glob", false)).toBe("Searching files");
    expect(getToolActionName("glob", true)).toBe("Searched files");
    expect(getToolActionName("grep", false)).toBe("Searching code");
    expect(getToolActionName("grep", true)).toBe("Searched code");
  });

  test("should return task delegation names", () => {
    expect(getToolActionName("task", false)).toBe("Delegating task");
    expect(getToolActionName("task", true)).toBe("Delegated task");
  });

  test("should return todo tool names", () => {
    expect(getToolActionName("todowrite", false)).toBe("Updating plan");
    expect(getToolActionName("todowrite", true)).toBe("Updated plan");
    expect(getToolActionName("todoread", false)).toBe("Reading plan");
    expect(getToolActionName("todoread", true)).toBe("Read plan");
  });

  test("should return question tool names", () => {
    expect(getToolActionName("question", false)).toBe("Asking question");
    expect(getToolActionName("question", true)).toBe("Asked question");
  });

  test("should handle case insensitivity", () => {
    expect(getToolActionName("READ", false)).toBe("Reading");
    expect(getToolActionName("Bash", true)).toBe("Ran");
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

  test("should fallback to path property for file operations", () => {
    expect(
      extractToolParameter("read", { path: "/path/to/file.ts" }, null),
    ).toBe("/path/to/file.ts");
  });

  test("should fallback to 'file' when no path provided", () => {
    expect(extractToolParameter("read", {}, null)).toBe("file");
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

  test("should strip worktree paths from absolute paths without workdir", () => {
    const worktreePath =
      "/home/user/.local/share/opencode/worktree/abc123/code-80/src/file.ts";
    expect(extractToolParameter("read", { filePath: worktreePath }, null)).toBe(
      "src/file.ts",
    );
  });

  test("should extract command for bash", () => {
    expect(extractToolParameter("bash", { command: "npm install" }, null)).toBe(
      "npm install",
    );
  });

  test("should fallback to 'command' when bash has no command", () => {
    expect(extractToolParameter("bash", {}, null)).toBe("command");
  });

  test("should extract pattern for glob/grep", () => {
    expect(extractToolParameter("glob", { pattern: "**/*.ts" }, null)).toBe(
      "**/*.ts",
    );
    expect(extractToolParameter("grep", { pattern: "TODO" }, null)).toBe(
      "TODO",
    );
  });

  test("should fallback to 'pattern' when glob/grep has no pattern", () => {
    expect(extractToolParameter("glob", {}, null)).toBe("pattern");
    expect(extractToolParameter("grep", {}, null)).toBe("pattern");
  });

  test("should extract description for task", () => {
    expect(
      extractToolParameter("task", { description: "Fix the bug" }, null),
    ).toBe("Fix the bug");
  });

  test("should fallback to 'task' when task has no description", () => {
    expect(extractToolParameter("task", {}, null)).toBe("task");
  });

  test("should extract question text for question tool", () => {
    expect(
      extractToolParameter(
        "question",
        {
          questions: [
            { question: "Which option?", header: "Select", options: [] },
          ],
        },
        null,
      ),
    ).toBe("Which option?");
  });

  test("should truncate long question text to 100 chars", () => {
    const longQuestion = "A".repeat(150);
    expect(
      extractToolParameter(
        "question",
        {
          questions: [{ question: longQuestion, header: "Q", options: [] }],
        },
        null,
      ),
    ).toBe("A".repeat(100));
  });

  test("should fallback to 'user input' for empty questions array", () => {
    expect(extractToolParameter("question", { questions: [] }, null)).toBe(
      "user input",
    );
  });

  test("should fallback to 'user input' for invalid questions format", () => {
    expect(
      extractToolParameter(
        "question",
        { questions: [{ invalid: true }] },
        null,
      ),
    ).toBe("user input");
  });

  test("should extract first value from unknown tool input", () => {
    expect(
      extractToolParameter("customtool", { name: "test-value" }, null),
    ).toBe("test-value");
  });

  test("should truncate long unknown tool values to 100 chars", () => {
    const longValue = "B".repeat(150);
    expect(extractToolParameter("customtool", { data: longValue }, null)).toBe(
      "B".repeat(100),
    );
  });

  test("should return tool name for array/object values in unknown tools", () => {
    expect(extractToolParameter("customtool", { items: [1, 2, 3] }, null)).toBe(
      "customtool",
    );
    expect(
      extractToolParameter("customtool", { config: { key: "value" } }, null),
    ).toBe("customtool");
  });

  test("should return tool name for empty input in unknown tools", () => {
    expect(extractToolParameter("customtool", {}, null)).toBe("customtool");
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

  test("should truncate long output", () => {
    const longOutput = "X".repeat(600);
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "echo test" },
        output: longOutput,
        title: "Bash",
        metadata: {},
        time: { start: now, end: now + 100 },
      },
    };

    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        result: "X".repeat(500) + "...(truncated)",
      },
    });
  });

  test("should replace absolute paths in output with relative paths", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "Error in /workdir/src/file.ts:10",
        title: "Bash",
        metadata: {},
        time: { start: now, end: now + 100 },
      },
    };

    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        result: "Error in src/file.ts:10",
      },
    });
  });

  test("should replace worktree paths in output even without workdir", () => {
    const ctxNoWorkdir = { linearSessionId: "linear-123", workdir: null };
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls" },
        output:
          "Error in /home/user/.local/share/opencode/worktree/abc123/code-80/src/file.ts",
        title: "Bash",
        metadata: {},
        time: { start: now, end: now + 100 },
      },
    };

    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");
    const result = processToolPart(part, state, ctxNoWorkdir);

    expect(result.actions[0]).toMatchObject({
      content: {
        result: "Error in src/file.ts",
      },
    });
  });

  test("should include thought for test commands", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "bun run test" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toEqual({
      type: "postActivity",
      sessionId: "linear-123",
      content: {
        type: "thought",
        body: "Running tests to verify changes...",
      },
      ephemeral: true,
    });
  });

  test("should include thought for bun run check command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "bun run check" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Running tests to verify changes...",
      },
    });
  });

  test("should include thought for gh pr create command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "gh pr create --title 'Fix bug'" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Creating pull request...",
      },
    });
  });

  test("should include thought for git commit command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "git commit -m 'fix: resolve issue'" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Committing changes...",
      },
    });
  });

  test("should include thought for npm install command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "npm install lodash" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Installing dependencies...",
      },
    });
  });

  test("should include thought for bun install command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "bun install" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Installing dependencies...",
      },
    });
  });

  test("should include thought for yarn install command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "yarn install" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Installing dependencies...",
      },
    });
  });

  test("should include thought for pnpm install command", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "pnpm install" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Installing dependencies...",
      },
    });
  });

  test("should include thought for grep tool", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "grep",
      state: {
        status: "running",
        input: { pattern: "TODO" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Searching codebase...",
      },
    });
  });

  test("should include thought for glob tool", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "glob",
      state: {
        status: "running",
        input: { pattern: "**/*.ts" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Finding relevant files...",
      },
    });
  });

  test("should include thought for task tool", () => {
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "task",
      state: {
        status: "running",
        input: { description: "Explore codebase" },
        time: { start: now },
      },
    };

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({
      content: {
        type: "thought",
        body: "Delegating subtask...",
      },
    });
  });

  test("should not include thought for simple read operations", () => {
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

    // Should only have action activity, no thought
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      content: {
        type: "action",
      },
    });
  });

  test("should return no actions for unknown tool status", () => {
    // Create a part with an unknown status to test defensive handling
    // This simulates receiving an unexpected status from the API
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentionally testing edge case with invalid status
    const part = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "read",
      state: {
        status: "pending", // Unknown status not in running/completed/error
        input: { filePath: "/workdir/src/file.ts" },
        time: { start: now },
      },
    } as unknown as ToolPart;

    const state = createInitialHandlerState();
    const result = processToolPart(part, state, ctx);

    expect(result.state).toBe(state);
    expect(result.actions).toHaveLength(0);
  });

  test("should handle null workdir gracefully", () => {
    const ctxNoWorkdir = { linearSessionId: "linear-123", workdir: null };
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/absolute/path/to/file.ts" },
        output: "Contents",
        title: "Read file",
        metadata: {},
        time: { start: now, end: now + 100 },
      },
    };

    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");
    const result = processToolPart(part, state, ctxNoWorkdir);

    expect(result.actions[0]).toMatchObject({
      content: {
        parameter: "/absolute/path/to/file.ts",
      },
    });
  });

  test("should truncate long error messages", () => {
    const longError = "E".repeat(600);
    const part: ToolPart = {
      type: "tool",
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "msg-1",
      tool: "bash",
      state: {
        status: "error",
        input: { command: "fail" },
        error: longError,
        time: { start: now, end: now + 100 },
      },
    };

    const state = createInitialHandlerState();
    state.runningTools.add("tool-1");
    const result = processToolPart(part, state, ctx);

    expect(result.actions[0]).toMatchObject({
      content: {
        result: "Error: " + "E".repeat(500) + "...(truncated)",
      },
    });
  });
});
