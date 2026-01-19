import type { SessionState } from "./SessionState";

/**
 * Worktree info for reuse across sessions
 */
export interface WorktreeInfo {
  workdir: string;
  branchName: string;
}

/**
 * A question option from OpenCode's question tool
 */
export interface QuestionOption {
  label: string;
  description: string;
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

/**
 * Repository for session state persistence
 */
export interface SessionRepository {
  /**
   * Get session state by Linear session ID
   */
  get(linearSessionId: string): Promise<SessionState | null>;

  /**
   * Save session state
   */
  save(state: SessionState): Promise<void>;

  /**
   * Delete session state
   */
  delete(linearSessionId: string): Promise<void>;

  /**
   * Find existing worktree info for an issue
   * Used to share worktrees across multiple agent sessions on the same issue
   */
  findWorktreeByIssue(issueId: string): Promise<WorktreeInfo | null>;

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
}
