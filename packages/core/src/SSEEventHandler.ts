import type {
  OpencodeClient,
  Event as OpencodeEvent,
  ToolPart,
  TextPart,
  Todo,
  Part,
} from "@opencode-ai/sdk";
import type { LinearAdapter } from "./linear/LinearAdapter";
import type { PlanItem } from "./linear/types";

/**
 * Prefix used by the commit-guard plugin to identify its errors
 */
const COMMIT_GUARD_PREFIX = "[COMMIT_GUARD]";

/**
 * Result from handling an SSE event
 */
export type SSEEventResult =
  | { action: "continue" }
  | { action: "break" }
  | { action: "retry"; reason: string };

/**
 * Tool name mapping for friendly action names
 */
const TOOL_ACTION_MAP: Record<string, { action: string; pastTense: string }> = {
  read: { action: "Reading", pastTense: "Read" },
  edit: { action: "Editing", pastTense: "Edited" },
  write: { action: "Creating", pastTense: "Created" },
  bash: { action: "Running", pastTense: "Ran" },
  glob: { action: "Searching files", pastTense: "Searched files" },
  grep: { action: "Searching code", pastTense: "Searched code" },
  task: { action: "Delegating task", pastTense: "Delegated task" },
  todowrite: { action: "Updating plan", pastTense: "Updated plan" },
  todoread: { action: "Reading plan", pastTense: "Read plan" },
};

/**
 * Maximum length for tool output before truncation
 */
const MAX_OUTPUT_LENGTH = 500;

/**
 * Get friendly tool action name
 */
function getToolActionName(toolName: string, completed: boolean): string {
  const mapping = TOOL_ACTION_MAP[toolName.toLowerCase()];
  if (!mapping) {
    return completed
      ? toolName.charAt(0).toUpperCase() + toolName.slice(1)
      : toolName.charAt(0).toUpperCase() + toolName.slice(1) + "ing";
  }
  return completed ? mapping.pastTense : mapping.action;
}

/**
 * Safely extract a string from an unknown input object
 */
function getString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

/**
 * Extract parameter from tool input for display
 */
function extractToolParameter(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const key = toolName.toLowerCase();
  switch (key) {
    case "read":
    case "edit":
    case "write":
      return getString(input, "filePath") ?? getString(input, "path") ?? "file";
    case "bash":
      return getString(input, "command") ?? "command";
    case "glob":
    case "grep":
      return getString(input, "pattern") ?? "pattern";
    case "task":
      return getString(input, "description") ?? "task";
    default: {
      const firstKey = Object.keys(input)[0];
      if (firstKey) {
        const value = input[firstKey];
        return String(value).slice(0, 100);
      }
      return toolName;
    }
  }
}

/**
 * Map OpenCode todo status to Linear plan status
 */
function mapTodoStatus(
  status: string,
): "pending" | "inProgress" | "completed" | "canceled" {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    case "cancelled":
      return "canceled";
    default:
      return "pending";
  }
}

/**
 * Truncate output if it exceeds max length
 */
function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + "...(truncated)";
  }
  return output;
}

/**
 * Get contextual thought message for tool execution
 */
function getToolThought(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const toolLower = toolName.toLowerCase();
  const command = getString(input, "command");

  // Bash commands
  if (toolLower === "bash" && command) {
    if (command.includes("test") || command.includes("bun run check")) {
      return "Running tests to verify changes...";
    }
    if (command.includes("gh pr create")) {
      return "Creating pull request...";
    }
    if (command.includes("git commit")) {
      return "Committing changes...";
    }
    if (command.includes("git push")) {
      return "Pushing changes to remote...";
    }
    if (command.includes("npm install") || command.includes("bun install")) {
      return "Installing dependencies...";
    }
  }

  // Search operations
  if (toolLower === "grep") {
    return "Searching codebase...";
  }

  if (toolLower === "glob") {
    return "Finding relevant files...";
  }

  // Task delegation
  if (toolLower === "task") {
    return "Delegating subtask...";
  }

  return null;
}

/**
 * Handles SSE events from OpenCode and posts activities to Linear.
 *
 * This replaces the plugin-based approach with a pure SDK/SSE approach,
 * keeping all Linear communication in the worker instead of the container.
 */
export class SSEEventHandler {
  /** Track sent text part IDs to avoid duplicates */
  private sentTextParts = new Set<string>();

  /** Track tool parts we've seen in running state */
  private runningTools = new Set<string>();

  /** Track files modified during session */
  private filesModified = new Set<string>();

  /** Track PR URL if created */
  private prUrl: string | null = null;

  /** Track test results */
  private testsRan = false;
  private testsPassed = false;

  /** Track agent's last text response */
  private agentFinalMessage: string | null = null;

  /** Track if session had errors that might need user intervention */
  private hadErrors = false;

  constructor(
    private readonly linear: LinearAdapter,
    private readonly linearSessionId: string,
    private readonly opencodeSessionId: string,
    private readonly opencodeClient: OpencodeClient,
  ) {}

  /**
   * Handle an SSE event from OpenCode
   *
   * @returns SSEEventResult indicating whether to continue, break, or retry
   */
  async handleEvent(event: OpencodeEvent): Promise<SSEEventResult> {
    // Handle specific event types we care about
    // Other event types (message.updated, session.created, etc.) are logged but not acted upon
    if (event.type === "message.part.updated") {
      await this.handlePartUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "todo.updated") {
      await this.handleTodoUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "permission.updated") {
      await this.handlePermissionUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "session.idle") {
      if (event.properties.sessionID === this.opencodeSessionId) {
        await this.handleSessionIdle();
        return { action: "break" };
      }
      return { action: "continue" };
    }

    if (event.type === "session.error") {
      if (event.properties.sessionID === this.opencodeSessionId) {
        return await this.handleSessionError(event.properties);
      }
      return { action: "continue" };
    }

    // All other event types - continue without action
    return { action: "continue" };
  }

  /**
   * Handle message.part.updated events
   */
  private async handlePartUpdated(properties: {
    part: Part;
    delta?: string;
  }): Promise<void> {
    const { part } = properties;

    // Only process parts for our session
    if (part.sessionID !== this.opencodeSessionId) {
      return;
    }

    // Handle tool and text parts - other part types are ignored
    if (part.type === "tool") {
      await this.handleToolPart(part);
    } else if (part.type === "text") {
      await this.handleTextPart(part);
    }
  }

  /**
   * Handle tool part updates
   */
  private async handleToolPart(part: ToolPart): Promise<void> {
    const { state, tool, id } = part;

    if (state.status === "running") {
      // Only post running state once per tool
      if (this.runningTools.has(id)) {
        return;
      }
      this.runningTools.add(id);

      // Post contextual thought if this is a meaningful operation
      const thought = getToolThought(tool, state.input);
      if (thought) {
        await this.linear.postActivity(
          this.linearSessionId,
          { type: "thought", body: thought },
          true, // ephemeral - will be replaced by the action result
        );
      }

      console.info({
        message: "Tool starting",
        stage: "sse-handler",
        tool,
        linearSessionId: this.linearSessionId,
        opencodeSessionId: this.opencodeSessionId,
      });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, false),
          parameter: extractToolParameter(tool, state.input),
        },
        false, // persistent
      );
    } else if (state.status === "completed") {
      // Clean up running state tracking
      this.runningTools.delete(id);

      // Track file modifications
      const toolLower = tool.toLowerCase();
      if (toolLower === "edit" || toolLower === "write") {
        const filePath =
          getString(state.input, "filePath") ?? getString(state.input, "path");
        if (filePath) {
          this.filesModified.add(filePath);
        }
      }

      // Track PR creation
      if (toolLower === "bash") {
        const command = getString(state.input, "command");
        if (command?.includes("gh pr create")) {
          // Extract PR URL from output (gh pr create outputs the URL)
          const urlMatch = state.output.match(
            /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
          );
          if (urlMatch) {
            this.prUrl = urlMatch[0];
          }
        }
        // Track test execution
        if (command?.includes("test") || command?.includes("bun run check")) {
          this.testsRan = true;
          this.testsPassed =
            !state.output.includes("FAIL") && !state.output.includes("Error");
        }
      }

      console.info({
        message: "Tool completed",
        stage: "sse-handler",
        tool,
        linearSessionId: this.linearSessionId,
        opencodeSessionId: this.opencodeSessionId,
        outputLength: state.output.length,
      });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, true),
          parameter: extractToolParameter(tool, state.input),
          result: truncateOutput(state.output),
        },
        false, // persistent
      );
    } else if (state.status === "error") {
      // Clean up running state tracking
      this.runningTools.delete(id);

      // Track errors for continue signal logic
      this.hadErrors = true;

      console.info({
        message: "Tool error",
        stage: "sse-handler",
        tool,
        linearSessionId: this.linearSessionId,
        opencodeSessionId: this.opencodeSessionId,
        error: state.error,
      });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, true),
          parameter: extractToolParameter(tool, state.input),
          result: `Error: ${truncateOutput(state.error)}`,
        },
        false, // persistent
      );
    }
  }

  /**
   * Handle text part updates
   *
   * Text parts are posted as response activities when complete.
   * We detect completion by checking if time.end is set.
   */
  private async handleTextPart(part: TextPart): Promise<void> {
    const { id, text, time } = part;

    // Skip if already sent - check and add BEFORE async operation to prevent race condition
    // where the same event arrives twice before the first postActivity completes
    if (this.sentTextParts.has(id)) {
      return;
    }
    this.sentTextParts.add(id);

    // Skip empty text
    if (!text.trim()) {
      return;
    }

    // Check if text is complete (has end time)
    if (!time?.end) {
      return;
    }

    // Track the agent's final message
    this.agentFinalMessage = text;

    console.info({
      message: "Text complete",
      stage: "sse-handler",
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
      textLength: text.length,
    });

    await this.linear.postActivity(
      this.linearSessionId,
      { type: "response", body: text },
      false, // persistent
    );
  }

  /**
   * Handle todo.updated events - sync to Linear plan
   */
  private async handleTodoUpdated(properties: {
    sessionID: string;
    todos: Todo[];
  }): Promise<void> {
    const { sessionID, todos } = properties;

    // Only process for our session
    if (sessionID !== this.opencodeSessionId) {
      return;
    }

    const plan: PlanItem[] = todos.map((todo) => ({
      content: todo.content,
      status: mapTodoStatus(todo.status),
    }));

    console.info({
      message: "Syncing todos to plan",
      stage: "sse-handler",
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
      todoCount: todos.length,
      plan: JSON.stringify(plan),
    });

    await this.linear.updatePlan(this.linearSessionId, plan);
  }

  /**
   * Handle permission.updated events - auto-approve all
   *
   * For an agentic coding tool working on delegated issues,
   * auto-approving permissions is appropriate since the user
   * has already granted trust by delegating the work.
   */
  private async handlePermissionUpdated(properties: {
    id: string;
    sessionID: string;
    [key: string]: unknown;
  }): Promise<void> {
    const { id, sessionID } = properties;

    // Only process for our session
    if (sessionID !== this.opencodeSessionId) {
      return;
    }

    console.info({
      message: "Auto-approving permission",
      stage: "sse-handler",
      permissionId: id,
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
    });

    try {
      // Use the SDK's permission reply endpoint
      // POST /session/{id}/permissions/{permissionID}
      await this.opencodeClient.postSessionIdPermissionsPermissionId({
        path: { id: this.opencodeSessionId, permissionID: id },
        body: { response: "always" },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Failed to reply to permission",
        stage: "sse-handler",
        permissionId: id,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle session.idle - send appropriate signal to Linear
   */
  private async handleSessionIdle(): Promise<void> {
    // Determine if session should continue or stop
    // Continue if: tests failed, had errors, or no substantial work done
    const shouldContinue =
      (this.testsRan && !this.testsPassed) ||
      this.hadErrors ||
      (this.filesModified.size === 0 && !this.prUrl);

    const signal = shouldContinue ? "continue" : "stop";

    console.info({
      message: `Session idle, sending ${signal} signal`,
      stage: "sse-handler",
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
      testsRan: this.testsRan,
      testsPassed: this.testsPassed,
      hadErrors: this.hadErrors,
      filesModified: this.filesModified.size,
      signal,
    });

    // Build rich completion message
    const summaryParts: string[] = [];

    // Include agent's final message if available
    if (this.agentFinalMessage) {
      summaryParts.push(this.agentFinalMessage);
      summaryParts.push("\n---\n");
    }

    summaryParts.push("## Summary");

    // Files modified
    if (this.filesModified.size > 0) {
      summaryParts.push(
        `\n**Files modified:** ${this.filesModified.size} file${this.filesModified.size === 1 ? "" : "s"}`,
      );
      if (this.filesModified.size <= 5) {
        summaryParts.push(
          Array.from(this.filesModified)
            .map((f) => `- \`${f}\``)
            .join("\n"),
        );
      }
    }

    // Test results
    if (this.testsRan) {
      const testStatus = this.testsPassed ? "✅ Passed" : "❌ Failed";
      summaryParts.push(`\n**Tests:** ${testStatus}`);
    }

    // PR link
    if (this.prUrl) {
      summaryParts.push(`\n**Pull Request:** ${this.prUrl}`);
    }

    // Add guidance if continuing
    if (shouldContinue) {
      summaryParts.push(
        "\n\n_Session paused. You can provide additional guidance or let me continue._",
      );
    }

    // Default message if no summary parts
    if (
      summaryParts.length === 0 ||
      (summaryParts.length === 1 && !this.agentFinalMessage)
    ) {
      summaryParts.push(
        shouldContinue
          ? "Paused. Awaiting further guidance."
          : "Task completed.",
      );
    }

    const completionMessage = summaryParts.join("\n");

    await this.linear.postActivity(
      this.linearSessionId,
      { type: "response", body: completionMessage },
      false, // persistent
      signal, // Signal completion or continuation to Linear
    );
  }

  /**
   * Handle session.error - report error to Linear
   *
   * If the error is from the commit-guard plugin, returns a retry signal
   * so the processor can re-prompt the agent with the error context.
   */
  private async handleSessionError(properties: {
    sessionID?: string;
    error?: {
      name?: string;
      data?: { message?: string };
    };
  }): Promise<SSEEventResult> {
    const { error } = properties;

    let errorMessage = "Unknown error";
    if (error?.data?.message) {
      errorMessage = error.data.message;
    } else if (error?.name) {
      errorMessage = error.name;
    }

    // Check if this is a commit guard error - these should trigger retry
    if (errorMessage.startsWith(COMMIT_GUARD_PREFIX)) {
      console.info({
        message: "Commit guard triggered, signaling retry",
        stage: "sse-handler",
        linearSessionId: this.linearSessionId,
        opencodeSessionId: this.opencodeSessionId,
      });

      // Post the error to Linear as a thought (not a fatal error)
      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "thought",
          body: errorMessage.replace(COMMIT_GUARD_PREFIX, "").trim(),
        },
        false,
      );

      return { action: "retry", reason: errorMessage };
    }

    // Regular error - post and break
    console.error({
      message: "Session error",
      stage: "sse-handler",
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
      error: errorMessage,
    });

    await this.linear.postError(this.linearSessionId, new Error(errorMessage));
    return { action: "break" };
  }
}
