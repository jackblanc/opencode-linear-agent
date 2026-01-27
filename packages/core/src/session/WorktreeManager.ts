import { Result } from "better-result";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { LinearService } from "../linear/LinearService";
import type { SessionRepository } from "./SessionRepository";
import type { Logger } from "../logger";
import { detectInstallCommand } from "../utils/package-manager";

/**
 * Result from resolving a worktree
 */
export interface WorktreeResolution {
  workdir: string;
  branchName: string;
  source: "existing_session" | "existing_worktree" | "created";
}

/**
 * Manages worktree creation and reuse logic.
 *
 * Extracted from LinearEventProcessor to isolate worktree-related concerns:
 * - Reusing worktrees from existing sessions
 * - Reusing worktrees from previous sessions on the same issue
 * - Creating new worktrees via OpenCode
 */
export class WorktreeManager {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
    private readonly repository: SessionRepository,
    private readonly repoDirectory: string,
  ) {}

  /**
   * Resolve or create a worktree for a session
   *
   * Checks in order:
   * 1. Existing state for this Linear session (reuse)
   * 2. Existing worktree for this issue from a previous session
   * 3. Create a new worktree via OpenCode
   *
   * @returns WorktreeResolution with workdir, branchName, and source
   */
  async resolveWorktree(
    linearSessionId: string,
    issue: string,
    log: Logger,
  ): Promise<Result<WorktreeResolution, Error>> {
    // Get existing state for this specific Linear session
    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.workdir) {
      // Same Linear session - reuse everything
      log.info("Reusing existing session worktree", {
        workdir: existingState.workdir,
        branchName: existingState.branchName,
      });

      return Result.ok({
        workdir: existingState.workdir,
        branchName: existingState.branchName,
        source: "existing_session" as const,
      });
    }

    // New Linear session - check if there's an existing worktree for this issue
    const existingWorktree = await this.repository.findWorktreeByIssue(issue);

    if (existingWorktree) {
      // Reuse worktree from a previous session on the same issue
      log.info("Reusing worktree from previous session on same issue", {
        workdir: existingWorktree.workdir,
        branchName: existingWorktree.branchName,
      });

      return Result.ok({
        workdir: existingWorktree.workdir,
        branchName: existingWorktree.branchName,
        source: "existing_worktree" as const,
      });
    }

    // No existing worktree - create one via OpenCode
    await this.linear.postStageActivity(linearSessionId, "git_setup");

    log.info("Creating worktree via OpenCode", {
      repoDirectory: this.repoDirectory,
    });

    // Detect the package manager from lockfile, skip install if none found
    const installCommand = detectInstallCommand(this.repoDirectory);
    if (installCommand) {
      log.info("Detected package manager", { installCommand });
    } else {
      log.info("No lockfile found, skipping dependency installation");
    }

    const worktreeResult = await this.opencode.createWorktree(
      this.repoDirectory,
      issue,
      installCommand,
    );

    if (Result.isError(worktreeResult)) {
      log.error("Error creating worktree", {
        error: worktreeResult.error.message,
        errorType: worktreeResult.error._tag,
      });
      return Result.err(worktreeResult.error);
    }

    log.info("Worktree created", {
      workdir: worktreeResult.value.directory,
      branchName: worktreeResult.value.branch,
    });

    return Result.ok({
      workdir: worktreeResult.value.directory,
      branchName: worktreeResult.value.branch,
      source: "created" as const,
    });
  }
}
