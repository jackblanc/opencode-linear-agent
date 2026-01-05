/**
 * Git status for determining session completion
 */
export interface GitStatus {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  branchName: string;
}

/**
 * Worktree information
 */
export interface WorktreeInfo {
  workdir: string;
  branchName: string;
}
