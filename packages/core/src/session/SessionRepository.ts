import type { SessionState } from "./SessionState";

/**
 * Worktree info for reuse across sessions
 */
export interface WorktreeInfo {
  workdir: string;
  branchName: string;
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
}
