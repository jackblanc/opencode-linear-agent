/**
 * Types for Linear agent activities and plans.
 */

/**
 * Signal metadata for elicitation activities (select signal with options)
 */
export interface SignalMetadata {
  options: Array<{ value: string; description?: string }>;
}

/**
 * Thought activity - internal reasoning, ephemeral progress updates
 */
interface ThoughtActivity {
  type: "thought";
  body?: string;
}

/**
 * Action activity - tool invocations with optional results
 */
interface ActionActivity {
  type: "action";
  action: string;
  parameter?: string;
  result?: string;
}

/**
 * Response activity - completed work, final outputs
 */
interface ResponseActivity {
  type: "response";
  body: string;
}

/**
 * Error activity - failures with context
 */
interface ErrorActivity {
  type: "error";
  body: string;
}

/**
 * Elicitation activity - requesting user input/clarification
 */
interface ElicitationActivity {
  type: "elicitation";
  body: string;
}

/**
 * Activity content for Linear - discriminated union
 */
export type ActivityContent =
  | ThoughtActivity
  | ActionActivity
  | ResponseActivity
  | ErrorActivity
  | ElicitationActivity;

/**
 * Plan item for Linear session
 */
export interface PlanItem {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/**
 * Elicitation signal types
 */
export type ElicitationSignal = "auth" | "select";
