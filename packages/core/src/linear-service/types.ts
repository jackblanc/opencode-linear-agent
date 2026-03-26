/**
 * Agent-to-human signals for elicitation activities
 *
 * Per Linear docs, these are the only valid signals an agent can send:
 * - auth: Waiting for user to authenticate/link account
 * - select: Waiting for user to select from options
 *
 * Note: "stop" and "continue" are human-to-agent signals only
 */
export type ElicitationSignal = "auth" | "select";

export interface IssueRepositoryCandidate {
  hostname: string;
  repositoryFullName: string;
}

export interface IssueRepositorySuggestion extends IssueRepositoryCandidate {
  confidence: number;
}

/**
 * Metadata for auth signal
 */
interface AuthSignalMetadata {
  url: string;
  userId?: string;
  providerName?: string;
}

/**
 * Metadata for select signal
 *
 * Per Linear docs, options should be objects with a `value` field.
 * If options are GitHub URLs, Linear automatically enriches them with icons.
 */
interface SelectSignalMetadata {
  options: Array<{ value: string; label?: string }>;
}

/**
 * Signal metadata for elicitation activities
 */
export type SignalMetadata = AuthSignalMetadata | SelectSignalMetadata;

/**
 * Base activity content for Linear
 */
interface BaseActivityContent {
  body?: string;
}

/**
 * Thought activity - internal reasoning, ephemeral progress updates
 */
interface ThoughtActivity extends BaseActivityContent {
  type: "thought";
}

/**
 * Action activity - tool invocations with optional results
 */
interface ActionActivity extends BaseActivityContent {
  type: "action";
  action: string;
  parameter?: string;
  result?: string;
}

/**
 * Response activity - completed work, final outputs
 */
interface ResponseActivity extends BaseActivityContent {
  type: "response";
  body: string;
}

/**
 * Error activity - failures with context
 */
interface ErrorActivity extends BaseActivityContent {
  type: "error";
  body: string;
}

/**
 * Elicitation activity - requesting user input/clarification
 *
 * Note: signalMetadata is passed separately to createAgentActivity,
 * not as part of content.
 */
interface ElicitationActivity extends BaseActivityContent {
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

/**
 * Issue workflow state from Linear
 *
 * The `type` field indicates the category of the state:
 * - triage: Issues awaiting triage (when triage mode is enabled)
 * - backlog: Issues in backlog (including custom states like "Icebox", "Later", etc.)
 * - unstarted: Issues ready to start (e.g., "Todo")
 * - started: Issues in progress
 * - completed: Issues that are done
 * - canceled: Issues that were canceled
 * - unknown: Any future or undocumented category returned by Linear
 *
 * Note: The Linear SDK types WorkflowState.type as `string`, so we define our own
 * narrower type based on the documented values.
 */
export interface IssueState {
  id: string;
  name: string;
  type:
    | "triage"
    | "backlog"
    | "unstarted"
    | "started"
    | "completed"
    | "canceled"
    | "unknown";
}
