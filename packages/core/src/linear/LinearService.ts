import type { Result } from "better-result";
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
 * Issue data returned from Linear API
 */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
}

/**
 * Label data returned from Linear API
 */
export interface LinearLabel {
  id: string;
  name: string;
}

/**
 * Attachment data returned from Linear API
 */
export interface LinearAttachment {
  id: string;
  url?: string;
  title?: string;
}

/**
 * Unified interface for all Linear operations.
 *
 * Wraps the Linear SDK client and returns Result types
 * instead of throwing exceptions.
 */
export interface LinearService {
  // ─────────────────────────────────────────────────────────────
  // Agent Activity Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Post an activity to a Linear session
   */
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
  ): Promise<Result<void, Error>>;

  /**
   * Post a processing stage activity (ephemeral thought)
   */
  postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void, Error>>;

  /**
   * Post an error activity to a Linear session
   */
  postError(sessionId: string, error: unknown): Promise<Result<void, Error>>;

  /**
   * Post an elicitation activity to request user input
   */
  postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, Error>>;

  /**
   * Set the external link for a Linear session
   */
  setExternalLink(sessionId: string, url: string): Promise<Result<void, Error>>;

  /**
   * Update the plan for a Linear session
   */
  updatePlan(sessionId: string, plan: PlanItem[]): Promise<Result<void, Error>>;

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Get an issue by ID
   */
  getIssue(issueId: string): Promise<Result<LinearIssue, Error>>;

  /**
   * Get labels for an issue
   */
  getIssueLabels(issueId: string): Promise<Result<LinearLabel[], Error>>;

  /**
   * Get attachments for an issue
   */
  getIssueAttachments(
    issueId: string,
  ): Promise<Result<LinearAttachment[], Error>>;
}
