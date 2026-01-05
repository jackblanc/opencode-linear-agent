import type { GitSetupStep } from "../linear/types";
import type { GitStatus, WorktreeInfo } from "./types";

/**
 * Callback for reporting git setup progress
 */
export type GitProgressCallback = (
  step: GitSetupStep,
  details?: string,
) => void | Promise<void>;

/**
 * Interface for git operations in the sandbox
 */
export interface GitOperations {
  /**
   * Ensure the repository is cloned to the sandbox
   */
  ensureRepoCloned(
    repoUrl: string,
    onProgress?: GitProgressCallback,
  ): Promise<void>;

  /**
   * Ensure a worktree exists for the session
   * Creates a new branch if needed, or checks out an existing one
   */
  ensureWorktree(
    sessionId: string,
    issueId: string,
    existingBranch?: string,
    onProgress?: GitProgressCallback,
  ): Promise<WorktreeInfo>;

  /**
   * Get the git status of a working directory
   */
  getStatus(workdir: string): Promise<GitStatus>;
}
