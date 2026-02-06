import type { ToolPart } from "@opencode-ai/sdk/v2";
import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";
import { isInstallCommand } from "../utils/package-manager";

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
  question: { action: "Asking question", pastTense: "Asked question" },
  mcp_question: { action: "Asking question", pastTense: "Asked question" },
};

/**
 * Maximum length for tool output before truncation
 */
const MAX_OUTPUT_LENGTH = 500;

/**
 * Convert a verb to its gerund (-ing) form with proper English rules.
 * Handles consonant doubling (run→running), silent-e dropping (make→making),
 * and special endings (see→seeing).
 */
function toGerund(verb: string): string {
  const lower = verb.toLowerCase();
  if (lower.endsWith("e") && !lower.endsWith("ee")) {
    return verb.slice(0, -1) + "ing";
  }
  const len = lower.length;
  if (len >= 3) {
    const last = lower.charAt(len - 1);
    const secondLast = lower.charAt(len - 2);
    const thirdLast = lower.charAt(len - 3);
    const vowels = "aeiou";
    const noDouble = "wxy";
    if (
      !vowels.includes(last) &&
      !noDouble.includes(last) &&
      vowels.includes(secondLast) &&
      !vowels.includes(thirdLast)
    ) {
      return verb + last + "ing";
    }
  }
  return verb + "ing";
}

/**
 * Get friendly tool action name
 */
function getToolActionName(toolName: string, completed: boolean): string {
  const mapping = TOOL_ACTION_MAP[toolName.toLowerCase()];
  if (!mapping) {
    const capitalized = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    return completed ? capitalized : toGerund(capitalized);
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
    if (worktreeMatch?.[1]) {
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
    case "question": {
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
    if (isInstallCommand(command)) {
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
 * Context needed for tool handler processing
 */
export interface ToolHandlerContext {
  linearSessionId: string;
  workdir: string | null;
}

/**
 * Process a tool part event - pure function
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
/**
 * Check if a tool is a question tool (handled separately by QuestionHandler)
 */
function isQuestionTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === "question" || lower.endsWith("_question");
}

export function processToolPart(
  part: ToolPart,
  state: HandlerState,
  ctx: ToolHandlerContext,
): HandlerResult<HandlerState> {
  const { state: toolState, tool, id } = part;
  const actions: Action[] = [];

  if (isQuestionTool(tool)) {
    return { state, actions: [] };
  }

  if (toolState.status === "running") {
    // Only post running state once per tool
    if (state.runningTools.has(id)) {
      return { state, actions: [] };
    }

    // Create new state with this tool added to running set
    const newState: HandlerState = {
      ...state,
      runningTools: new Set([...state.runningTools, id]),
    };

    // Post contextual thought if this is a meaningful operation
    const thought = getToolThought(tool, toolState.input);
    if (thought) {
      actions.push({
        type: "postActivity",
        sessionId: ctx.linearSessionId,
        content: { type: "thought", body: thought },
        ephemeral: true,
      });
    }

    // Post running action activity
    actions.push({
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: {
        type: "action",
        action: getToolActionName(tool, false),
        parameter: extractToolParameter(tool, toolState.input, ctx.workdir),
      },
      ephemeral: true,
    });

    return { state: newState, actions };
  }

  if (toolState.status === "completed") {
    // Clean up running state tracking
    const newRunningTools = new Set(state.runningTools);
    newRunningTools.delete(id);
    const newState: HandlerState = {
      ...state,
      runningTools: newRunningTools,
    };

    // Post completed action activity
    actions.push({
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: {
        type: "action",
        action: getToolActionName(tool, true),
        parameter: extractToolParameter(tool, toolState.input, ctx.workdir),
        result: truncateOutput(
          replacePathsInOutput(toolState.output, ctx.workdir),
        ),
      },
      ephemeral: false,
    });

    return { state: newState, actions };
  }

  if (toolState.status === "error") {
    // Clean up running state tracking
    const newRunningTools = new Set(state.runningTools);
    newRunningTools.delete(id);
    const newState: HandlerState = {
      ...state,
      runningTools: newRunningTools,
    };

    // Post error action activity
    actions.push({
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: {
        type: "action",
        action: getToolActionName(tool, true),
        parameter: extractToolParameter(tool, toolState.input, ctx.workdir),
        result: `Error: ${truncateOutput(replacePathsInOutput(toolState.error, ctx.workdir))}`,
      },
      ephemeral: false,
    });

    return { state: newState, actions };
  }

  // Unknown status - no change
  return { state, actions: [] };
}
