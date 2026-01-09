/**
 * Metadata for auth signal
 */
export interface AuthSignalMetadata {
  url: string;
  userId?: string;
  providerName?: string;
}

/**
 * Metadata for select signal
 */
export interface SelectSignalMetadata {
  options: string[];
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
export interface ThoughtActivity extends BaseActivityContent {
  type: "thought";
}

/**
 * Action activity - tool invocations with optional results
 */
export interface ActionActivity extends BaseActivityContent {
  type: "action";
  action: string;
  parameter?: string;
  result?: string;
}

/**
 * Response activity - completed work, final outputs
 */
export interface ResponseActivity extends BaseActivityContent {
  type: "response";
  body: string;
}

/**
 * Error activity - failures with context
 */
export interface ErrorActivity extends BaseActivityContent {
  type: "error";
  body: string;
}

/**
 * Elicitation activity - requesting user input/clarification
 */
export interface ElicitationActivity extends BaseActivityContent {
  type: "elicitation";
  body: string;
  signalMetadata?: SignalMetadata;
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
 * Granular steps within the git setup process
 *
 * These provide more detailed progress updates during workspace setup.
 */
export type GitSetupStep =
  | "checking_repo"
  | "cloning_repo"
  | "checking_worktree"
  | "checking_branch"
  | "creating_worktree"
  | "configuring_git"
  | "installing_dependencies";

/**
 * Human-readable descriptions for each git setup step
 */
export const GIT_STEP_MESSAGES: Record<GitSetupStep, string> = {
  checking_repo: "Checking repository...",
  cloning_repo: "Cloning repository...",
  checking_worktree: "Checking worktree...",
  checking_branch: "Checking branch on remote...",
  creating_worktree: "Creating worktree...",
  configuring_git: "Configuring git...",
  installing_dependencies: "Installing dependencies...",
};
