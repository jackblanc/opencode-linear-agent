import type { SessionState } from "./SessionState";

/**
 * A question option from OpenCode's question tool
 */
export interface QuestionOption {
  /** Canonical OpenCode option label used for replies */
  label: string;
  /** Optional option subtitle/description from OpenCode */
  description: string;
  /** Linear select `value` sent in signal metadata */
  value: string;
  /** Candidate texts accepted when matching user replies */
  aliases: string[];
}

/**
 * A single question from OpenCode's question tool
 */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

/**
 * A pending question asked by OpenCode that's awaiting user response via Linear
 */
export interface PendingQuestion {
  /** OpenCode question request ID */
  requestId: string;
  /** OpenCode session ID */
  opencodeSessionId: string;
  /** Linear session ID */
  linearSessionId: string;
  /** Working directory for OpenCode calls */
  workdir: string;
  /** Linear issue identifier (e.g., "CODE-123") */
  issueId: string;
  /** The questions asked */
  questions: QuestionInfo[];
  /** Responses collected so far (null = not yet answered) */
  answers: Array<string[] | null>;
  /** Timestamp when question was asked */
  createdAt: number;
}

/**
 * A pending permission request from OpenCode that's awaiting user approval via Linear
 */
export interface PendingPermission {
  /** OpenCode permission request ID */
  requestId: string;
  /** OpenCode session ID */
  opencodeSessionId: string;
  /** Linear session ID */
  linearSessionId: string;
  /** Working directory for OpenCode calls */
  workdir: string;
  /** Linear issue identifier (e.g., "CODE-123") */
  issueId: string;
  /** Permission type (e.g., "Bash", "Write", "Edit") */
  permission: string;
  /** File patterns that need permission */
  patterns: string[];
  /** Additional metadata from the permission request */
  metadata: Record<string, unknown>;
  /** Timestamp when permission was requested */
  createdAt: number;
}

export interface RepoSelectionOption {
  label: string;
  labelValue: string;
  aliases: string[];
}

export interface PendingRepoSelection {
  linearSessionId: string;
  issueId: string;
  options: RepoSelectionOption[];
  promptContext?: string;
  createdAt: number;
}

/**
 * Repository for session state persistence
 */
export interface SessionRepository {
  /**
   * Get session state by Linear session ID
   */
  get(linearSessionId: string): Promise<SessionState | null>;

  /**
   * Get the latest session state for an issue
   */
  getByIssueId(issueId: string): Promise<SessionState | null>;

  /**
   * Save session state
   */
  save(state: SessionState): Promise<void>;

  /**
   * Delete session state
   */
  delete(linearSessionId: string): Promise<void>;

  /**
   * Get pending question for a Linear session
   */
  getPendingQuestion(linearSessionId: string): Promise<PendingQuestion | null>;

  /**
   * Save pending question
   */
  savePendingQuestion(question: PendingQuestion): Promise<void>;

  /**
   * Delete pending question
   */
  deletePendingQuestion(linearSessionId: string): Promise<void>;

  /**
   * Get pending permission for a Linear session
   */
  getPendingPermission(
    linearSessionId: string,
  ): Promise<PendingPermission | null>;

  /**
   * Save pending permission
   */
  savePendingPermission(permission: PendingPermission): Promise<void>;

  /**
   * Delete pending permission
   */
  deletePendingPermission(linearSessionId: string): Promise<void>;

  getPendingRepoSelection(
    linearSessionId: string,
  ): Promise<PendingRepoSelection | null>;

  savePendingRepoSelection(selection: PendingRepoSelection): Promise<void>;

  deletePendingRepoSelection(linearSessionId: string): Promise<void>;
}
