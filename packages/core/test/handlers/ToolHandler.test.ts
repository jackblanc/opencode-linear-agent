import { describe, test, expect } from "bun:test";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import { processToolPart } from "../../src/handlers/ToolHandler";
import { createInitialHandlerState } from "../../src/session/SessionState";

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
