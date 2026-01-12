import type { ToolPart } from "@opencode-ai/sdk/v2";
import type { LinearService } from "../linear/LinearService";
import type { Logger } from "../logger";

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
  mcp_question: { action: "Asking question", pastTense: "Asked question" },
};

/**
 * Maximum length for tool output before truncation
 */
const MAX_OUTPUT_LENGTH = 500;

/**
 * Get friendly tool action name
 */
export function getToolActionName(
  toolName: string,
  completed: boolean,
): string {
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
 * Replace all absolute paths in a string with relative paths
 * Handles tool output that may contain multiple file paths
 */
function replacePathsInOutput(output: string, workdir: string | null): string {
  if (!workdir) {
    // Try worktree pattern replacement even without explicit workdir
    return output.replace(
      /\/[^\s:]+\/\.local\/share\/opencode\/worktree\/[^/]+\/[^/]+\/([^\s:]+)/g,
      "$1",
    );
  }

  // Escape special regex chars in workdir for use in pattern
  const escapedWorkdir = workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Match workdir followed by path characters (not whitespace or common delimiters)
  const pattern = new RegExp(`${escapedWorkdir}/?([^\\s:]+)`, "g");

  return output.replace(pattern, "$1");
}

/**
 * Extract parameter from tool input for display
 */
export function extractToolParameter(
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
    case "mcp_question": {
      // Extract question text from the questions array
      const questions = input["questions"];
      if (Array.isArray(questions) && questions.length > 0) {
        const first = questions[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "question" in first &&
          typeof first.question === "string"
        ) {
          return first.question.slice(0, 100);
        }
      }
      return "user input";
    }
    default: {
      const firstKey = Object.keys(input)[0];
      if (firstKey) {
        const value = input[firstKey];
        // Handle arrays and objects gracefully - don't stringify them directly
        if (
          Array.isArray(value) ||
          (typeof value === "object" && value !== null)
        ) {
          return toolName;
        }
        return String(value).slice(0, 100);
      }
      return toolName;
    }
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
 * Handles tool part events from OpenCode and posts activities to Linear.
 */
export class ToolHandler {
  /** Track tool parts we've seen in running state */
  private runningTools = new Set<string>();

  constructor(
    private readonly linear: LinearService,
    private readonly linearSessionId: string,
    private readonly log: Logger,
    private readonly workdir: string | null = null,
  ) {}

  /**
   * Handle a tool part update
   */
  async handleToolPart(part: ToolPart): Promise<void> {
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
        true, // ephemeral - will be replaced by the completed action
      );
    } else if (state.status === "completed") {
      // Clean up running state tracking
      this.runningTools.delete(id);

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
          result: truncateOutput(
            replacePathsInOutput(state.output, this.workdir),
          ),
        },
        false, // persistent
      );
    } else if (state.status === "error") {
      // Clean up running state tracking
      this.runningTools.delete(id);

      this.log.info("Tool error", { tool, error: state.error });

      await this.linear.postActivity(
        this.linearSessionId,
        {
          type: "action",
          action: getToolActionName(tool, true),
          parameter: extractToolParameter(tool, state.input, this.workdir),
          result: `Error: ${truncateOutput(replacePathsInOutput(state.error, this.workdir))}`,
        },
        false, // persistent
      );
    }
  }
}
