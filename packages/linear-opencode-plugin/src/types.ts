/**
 * Linear Activity content types for agent sessions
 */
export type LinearActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/**
 * Linear Plan step for agent sessions
 */
export interface LinearPlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/**
 * Plugin configuration options
 */
export interface LinearPluginOptions {
  /**
   * Linear OAuth access token.
   * Falls back to LINEAR_ACCESS_TOKEN environment variable.
   */
  accessToken?: string;

  /**
   * Prefix used in OpenCode session titles to identify Linear sessions.
   * Default: "linear:"
   */
  sessionPrefix?: string;

  /**
   * Maximum length of tool output before truncation.
   * Default: 500
   */
  maxResultLength?: number;

  /**
   * Enable debug logging.
   * Default: false
   */
  debug?: boolean;
}

/**
 * Tool name mapping for friendly action names in Linear
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
