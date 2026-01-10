import type {
  OpencodeClient,
  Event as OpencodeEvent,
  ToolPart,
  TextPart,
  Todo,
  Part,
} from "@opencode-ai/sdk/v2";
import type { LinearAdapter } from "./linear/LinearAdapter";
import type { PlanItem } from "./linear/types";
import type { Logger } from "./logger";

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
 * Convert an absolute path to a relative path from workdir
 * Makes logs more readable by removing the long worktree prefix
 */
function toRelativePath(absolutePath: string, workdir: string | null): string {
  if (!workdir || !absolutePath.startsWith(workdir)) {
    // If no workdir or path doesn't start with it, try to extract just the repo-relative part
    // Worktree paths look like: /home/user/.local/share/opencode/worktree/<hash>/<issue-slug>/...
    const worktreeMatch = absolutePath.match(/\/worktree\/[^/]+\/[^/]+\/(.+)$/);
    if (worktreeMatch) {
      return worktreeMatch[1];
    }
    return absolutePath;
  }

  // Remove workdir prefix and leading slash
  let relative = absolutePath.slice(workdir.length);
  if (relative.startsWith("/")) {
    relative = relative.slice(1);
  }
  return relative || absolutePath;
}

/**
 * Extract parameter from tool input for display
 */
function extractToolParameter(
  toolName: string,
  input: Record<string, unknown>,
  workdir: string | null = null,
): string {
  const key = toolName.toLowerCase();
  switch (key) {
    case "read":
    case "edit":
    case "write": {
      const filePath =
        getString(input, "filePath") ?? getString(input, "path") ?? "file";
      return toRelativePath(filePath, workdir);
    }
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
    private readonly opcodeClient: OpencodeClient,
    private readonly log: Logger,
    private readonly workdir: string | null = null,
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

    if (event.type === "permission.asked") {
      await this.handlePermissionAsked(event.properties);
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

      this.log.info("Tool starting", { tool });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, false),
          parameter: extractToolParameter(tool, state.input, this.workdir),
        },
        false, // persistent
      );
    } else if (state.status === "completed") {
      // Clean up running state tracking
      this.runningTools.delete(id);

      // Track file modifications (use relative path for display)
      const toolLower = tool.toLowerCase();
      if (toolLower === "edit" || toolLower === "write") {
        const filePath =
          getString(state.input, "filePath") ?? getString(state.input, "path");
        if (filePath) {
          this.filesModified.add(toRelativePath(filePath, this.workdir));
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

      this.log.info("Tool completed", {
        tool,
        outputLength: state.output.length,
      });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, true),
          parameter: extractToolParameter(tool, state.input, this.workdir),
          result: truncateOutput(state.output),
        },
        false, // persistent
      );
    } else if (state.status === "error") {
      // Clean up running state tracking
      this.runningTools.delete(id);

      // Track errors for continue signal logic
      this.hadErrors = true;

      this.log.info("Tool error", { tool, error: state.error });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, true),
          parameter: extractToolParameter(tool, state.input, this.workdir),
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

    this.log.info("Text complete", { textLength: text.length });

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

    this.log.info("Syncing todos to plan", { todoCount: todos.length });

    await this.linear.updatePlan(this.linearSessionId, plan);
  }

  /**
   * Handle permission.asked events - auto-approve all
   *
   * For an agentic coding tool working on delegated issues,
   * auto-approving permissions is appropriate since the user
   * has already granted trust by delegating the work.
   */
  private async handlePermissionAsked(properties: {
    id: string;
    sessionID: string;
    permission: string;
    [key: string]: unknown;
  }): Promise<void> {
    const { id, sessionID, permission } = properties;

    // Only process for our session
    if (sessionID !== this.opencodeSessionId) {
      return;
    }

    this.log.info("Auto-approving permission", { requestId: id, permission });

    try {
      // Use the SDK's permission reply endpoint
      await this.opcodeClient.permission.reply({
        requestID: id,
        reply: "always",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log.error("Failed to reply to permission", {
        requestId: id,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle session.idle - send appropriate activity to Linear
   *
   * Based on Linear's docs:
   * - `response` type indicates work is complete (no signal needed)
   * - `elicitation` type requests user input when agent needs guidance
   * - Signals like `stop` are human-to-agent only (for prompt activities)
   */
  private async handleSessionIdle(): Promise<void> {
    // Determine if session needs user input to continue
    // Request input if: tests failed, had errors, or no substantial work done
    const needsUserInput =
      (this.testsRan && !this.testsPassed) ||
      this.hadErrors ||
      (this.filesModified.size === 0 && !this.prUrl);

    this.log.info("Session idle", {
      testsRan: this.testsRan,
      testsPassed: this.testsPassed,
      hadErrors: this.hadErrors,
      filesModified: this.filesModified.size,
      needsUserInput,
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

    // Add guidance if needs user input
    if (needsUserInput) {
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
        needsUserInput
          ? "Paused. Awaiting further guidance."
          : "Task completed.",
      );
    }

    const completionMessage = summaryParts.join("\n");

    if (needsUserInput) {
      // Use elicitation to request user input - session stays active
      await this.linear.postActivity(
        this.linearSessionId,
        { type: "elicitation", body: completionMessage },
        false, // persistent
      );
    } else {
      // Use response to indicate work is complete
      await this.linear.postActivity(
        this.linearSessionId,
        { type: "response", body: completionMessage },
        false, // persistent
      );
    }
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
      this.log.info("Commit guard triggered, signaling retry");

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
    this.log.error("Session error", { error: errorMessage });

    await this.linear.postError(this.linearSessionId, new Error(errorMessage));
    return { action: "break" };
  }
}
