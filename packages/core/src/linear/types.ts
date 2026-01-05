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
