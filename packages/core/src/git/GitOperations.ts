import type { GitStatus, WorktreeInfo } from "./types";

/**
 * Interface for git operations in the sandbox
 */
export interface GitOperations {
  /**
   * Ensure the repository is cloned to the sandbox
   */
  ensureRepoCloned(repoUrl: string): Promise<void>;

  /**
   * Ensure a worktree exists for the session
   * Creates a new branch if needed, or checks out an existing one
   */
  ensureWorktree(
    sessionId: string,
    issueId: string,
    existingBranch?: string,
  ): Promise<WorktreeInfo>;

  /**
   * Get the git status of a working directory
   */
  getStatus(workdir: string): Promise<GitStatus>;
}
