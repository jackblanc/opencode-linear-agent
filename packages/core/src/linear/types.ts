/**
 * Activity content for Linear
 */
export interface ActivityContent {
  type: "thought" | "action" | "response" | "error" | "elicitation";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

/**
 * Plan item for Linear session
 */
export interface PlanItem {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}
