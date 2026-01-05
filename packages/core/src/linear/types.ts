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

/**
 * Processing stages for Linear status updates
 *
 * These stages are posted as ephemeral activities to Linear
 * to give users visibility into where processing is in the pipeline.
 */
export type ProcessingStage =
  | "webhook_received"
  | "event_enqueued"
  | "processing_started"
  | "sandbox_initializing"
  | "git_setup"
  | "session_ready"
  | "sending_prompt";

/**
 * Human-readable descriptions for each processing stage
 */
export const STAGE_MESSAGES: Record<ProcessingStage, string> = {
  webhook_received: "Webhook received, queueing for processing...",
  event_enqueued: "Event enqueued for processing...",
  processing_started: "Processing started...",
  sandbox_initializing: "Initializing sandbox environment...",
  git_setup: "Setting up workspace...",
  session_ready: "Session ready...",
  sending_prompt: "Sending task to AI agent...",
};
