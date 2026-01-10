import type {
  ActivityContent,
  PlanItem,
  ProcessingStage,
  SignalMetadata,
} from "./types";

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

/**
 * Adapter interface for Linear API operations
 */
export interface LinearAdapter {
  /**
   * Post an activity to a Linear session
   *
   * Note: Signals are not used with regular activities. Use postElicitation
   * for activities that require user input with auth/select signals.
   */
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
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
    signal: ElicitationSignal,
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
