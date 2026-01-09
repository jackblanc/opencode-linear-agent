import type {
  ActivityContent,
  GitSetupStep,
  PlanItem,
  ProcessingStage,
  SignalMetadata,
} from "./types";

/**
 * Signal to send with an activity
 *
 * - stop: Session is complete, no further work expected
 * - continue: Session paused but can resume with more input
 * - auth: Waiting for user to authenticate/link account
 * - select: Waiting for user to select from options
 */
export type ActivitySignal = "stop" | "continue" | "auth" | "select";

/**
 * Adapter interface for Linear API operations
 */
export interface LinearAdapter {
  /**
   * Post an activity to a Linear session
   */
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
    signal?: ActivitySignal,
  ): Promise<void>;

  /**
   * Post a processing stage activity (ephemeral thought)
   *
   * These are used to give users visibility into where processing
   * is in the pipeline.
   */
  postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<void>;

  /**
   * Post a git setup step activity (ephemeral thought)
   *
   * These provide granular progress updates during workspace setup.
   */
  postGitStepActivity(
    sessionId: string,
    step: GitSetupStep,
    details?: string,
  ): Promise<void>;

  /**
   * Post an error activity to a Linear session
   */
  postError(sessionId: string, error: unknown): Promise<void>;

  /**
   * Post an elicitation activity to request user input
   *
   * @param sessionId - Linear session ID
   * @param body - Question or prompt for the user
   * @param signal - Type of elicitation (auth for authentication, select for options)
   * @param metadata - Signal metadata (options for select, url for auth)
   */
  postElicitation(
    sessionId: string,
    body: string,
    signal: "auth" | "select",
    metadata?: SignalMetadata,
  ): Promise<void>;

  /**
   * Set the external link for a Linear session
   */
  setExternalLink(sessionId: string, url: string): Promise<void>;

  /**
   * Update the plan for a Linear session
   */
  updatePlan(sessionId: string, plan: PlanItem[]): Promise<void>;
}
