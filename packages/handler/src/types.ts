import type { ToolState, Todo } from "@opencode-ai/sdk";

/**
 * Linear Agent Activity content types
 */
export type LinearActivityContent =
  | {
      type: "thought";
      body: string;
    }
  | {
      type: "elicitation";
      body: string;
    }
  | {
      type: "action";
      action: string;
      parameter: string;
      result?: string;
    }
  | {
      type: "response";
      body: string;
    }
  | {
      type: "error";
      body: string;
    };

/**
 * Linear Agent Plan step
 */
export interface LinearPlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/**
 * Session state stored in Durable Object
 */
export interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  repoCloned: boolean;
  lastActivityTime: number;
}

/**
 * Mapping result from OpenCode part to Linear activity
 */
export interface MappingResult {
  content: LinearActivityContent;
  ephemeral?: boolean;
}

/**
 * Tool name mapping for Linear activities
 */
export const TOOL_ACTION_MAP: Record<
  string,
  { action: string; pastTense: string }
> = {
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
 * Get friendly tool name for Linear
 */
export function getToolActionName(toolName: string, state: ToolState): string {
  const toolKey = toolName.toLowerCase();
  const mapping = TOOL_ACTION_MAP[toolKey];

  if (!mapping) {
    // Fallback for unknown tools
    if (state.status === "completed") {
      return toolName.charAt(0).toUpperCase() + toolName.slice(1) + "d";
    }
    return toolName.charAt(0).toUpperCase() + toolName.slice(1) + "ing";
  }

  return state.status === "completed" ? mapping.pastTense : mapping.action;
}

/**
 * Extract parameter from tool input
 */
export function extractToolParameter(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const toolKey = toolName.toLowerCase();

  switch (toolKey) {
    case "read":
    case "edit":
    case "write":
      return (input.filePath as string) || (input.path as string) || "file";
    case "bash":
      return (input.command as string) || "command";
    case "glob":
    case "grep":
      return (input.pattern as string) || (input.query as string) || "pattern";
    case "task":
      return (
        (input.prompt as string) || (input.description as string) || "task"
      );
    default:
      // Generic fallback
      const firstKey = Object.keys(input)[0];
      return firstKey ? String(input[firstKey]) : toolName;
  }
}

/**
 * Format tool result for Linear
 */
export function formatToolResult(output: string, maxLength = 500): string {
  if (output.length <= maxLength) {
    return output;
  }
  return output.slice(0, maxLength) + "\n...(truncated)";
}

/**
 * Map OpenCode Todo status to Linear Plan status
 */
export function mapTodoStatusToPlanStatus(
  status: Todo["status"],
): LinearPlanStep["status"] {
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
