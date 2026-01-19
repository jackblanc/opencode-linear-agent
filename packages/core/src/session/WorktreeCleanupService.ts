import { Result } from "better-result";
import { $ } from "bun";
import type { SessionRepository, WorktreeInfo } from "./SessionRepository";
import type { Logger } from "../logger";

/**
 * Result of a worktree cleanup operation
 */
export interface CleanupResult {
  issueId: string;
  workdir: string | null;
  gitWorktreeRemoved: boolean;
  directoryRemoved: boolean;
  storageCleared: boolean;
}

/**
 * Service for cleaning up worktrees after PR merge or issue completion.
 *
 * Handles:
 * - Removing git worktree reference
 * - Deleting worktree directory
 * - Clearing worktree info from storage
 */
export class WorktreeCleanupService {
  constructor(private readonly repository: SessionRepository) {}

  /**
   * Clean up a worktree for an issue
   *
   * @param issueId - The Linear issue identifier (e.g., "CODE-123")
   * @param log - Logger instance
   * @returns Result with cleanup details or error
   */
  async cleanup(
    issueId: string,
    log: Logger,
  ): Promise<Result<CleanupResult, Error>> {
    const taggedLog = log.tag("issueId", issueId);

    const worktreeInfo = await this.repository.findWorktreeByIssue(issueId);

    if (!worktreeInfo) {
      taggedLog.info("No worktree found for issue, nothing to clean up");
      return Result.ok({
        issueId,
        workdir: null,
        gitWorktreeRemoved: false,
        directoryRemoved: false,
        storageCleared: false,
      });
    }

    taggedLog.info("Found worktree to clean up", {
      workdir: worktreeInfo.workdir,
      branchName: worktreeInfo.branchName,
    });

    const result = await this.removeWorktree(worktreeInfo, taggedLog);

    await this.repository.deleteWorktreeByIssue(issueId);
    taggedLog.info("Cleared worktree info from storage");

    return Result.ok({
      issueId,
      workdir: worktreeInfo.workdir,
      gitWorktreeRemoved: result.gitWorktreeRemoved,
      directoryRemoved: result.directoryRemoved,
      storageCleared: true,
    });
  }

  /**
   * Remove git worktree and directory
   */
  private async removeWorktree(
    worktreeInfo: WorktreeInfo,
    log: Logger,
  ): Promise<{ gitWorktreeRemoved: boolean; directoryRemoved: boolean }> {
    let gitWorktreeRemoved = false;
    let directoryRemoved = false;

    try {
      await $`git worktree remove --force ${worktreeInfo.workdir}`.quiet();
      log.info("Git worktree removed", { workdir: worktreeInfo.workdir });
      gitWorktreeRemoved = true;
      directoryRemoved = true;
    } catch (gitError) {
      log.warn("git worktree remove failed, attempting direct removal", {
        error: gitError instanceof Error ? gitError.message : String(gitError),
      });

      try {
        await $`rm -rf ${worktreeInfo.workdir}`.quiet();
        log.info("Directory removed directly", {
          workdir: worktreeInfo.workdir,
        });
        directoryRemoved = true;
      } catch (rmError) {
        log.error("Failed to remove worktree directory", {
          error: rmError instanceof Error ? rmError.message : String(rmError),
          workdir: worktreeInfo.workdir,
        });
      }
    }

    return { gitWorktreeRemoved, directoryRemoved };
  }
}
