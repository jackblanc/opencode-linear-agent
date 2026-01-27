import type { Result } from "better-result";
import type { LinearServiceError } from "../errors";
import type {
  ActivityContent,
  IssueState,
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
 * Wraps the Linear SDK client and returns Result types with typed errors
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
  ): Promise<Result<void, LinearServiceError>>;

  /**
   * Post a processing stage activity (ephemeral thought)
   */
  postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void, LinearServiceError>>;

  /**
   * Post an error activity to a Linear session
   */
  postError(
    sessionId: string,
    error: unknown,
  ): Promise<Result<void, LinearServiceError>>;

  /**
   * Post an elicitation activity to request user input
   */
  postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, LinearServiceError>>;

  /**
   * Set the external link for a Linear session
   */
  setExternalLink(
    sessionId: string,
    url: string,
  ): Promise<Result<void, LinearServiceError>>;

  /**
   * Update the plan for a Linear session
   */
  updatePlan(
    sessionId: string,
    plan: PlanItem[],
  ): Promise<Result<void, LinearServiceError>>;

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Get an issue by ID
   */
  getIssue(issueId: string): Promise<Result<LinearIssue, LinearServiceError>>;

  /**
   * Get labels for an issue
   */
  getIssueLabels(
    issueId: string,
  ): Promise<Result<LinearLabel[], LinearServiceError>>;

  /**
   * Get attachments for an issue
   */
  getIssueAttachments(
    issueId: string,
  ): Promise<Result<LinearAttachment[], LinearServiceError>>;

  // ─────────────────────────────────────────────────────────────
  // Issue Update Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Update issue status to "In Progress" (first started status)
   *
   * Per Linear best practices: "If your agent is delegated to work on an issue
   * that is not in a started, completed, or canceled status type, move the
   * issue to the first status in started when your agent begins work."
   *
   * This method moves the issue to the team's first "started" status (lowest position)
   * regardless of current status (even if already "In Review").
   *
   * @param issueId - The issue ID to update
   */
  moveIssueToInProgress(
    issueId: string,
  ): Promise<Result<void, LinearServiceError>>;

  /**
   * Get the workflow state for an issue
   *
   * Used to determine if the agent should operate in "plan" or "build" mode.
   * Issues in triage or backlog states trigger plan mode.
   *
   * @param issueId - The issue ID to fetch state for
   */
  getIssueState(
    issueId: string,
  ): Promise<Result<IssueState, LinearServiceError>>;
}
