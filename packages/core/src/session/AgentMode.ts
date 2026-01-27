import type { IssueState } from "../linear/types";

/**
 * Agent operating mode
 *
 * - plan: Analyze issue and write implementation plan (for triage/backlog issues)
 * - build: Implement the issue and create a PR (for issues ready to work on)
 */
export type AgentMode = "plan" | "build";

/**
 * Determine the agent mode based on issue workflow state
 *
 * Issues in "triage" or "backlog" state types trigger plan mode.
 * This includes custom-named states like "Icebox" which have type "backlog".
 *
 * All other states (unstarted, started, completed, canceled) trigger build mode.
 *
 * @param stateType - The workflow state type from Linear
 * @returns The agent mode to use
 */
export function determineAgentMode(stateType: IssueState["type"]): AgentMode {
  if (stateType === "triage" || stateType === "backlog") {
    return "plan";
  }
  return "build";
}
