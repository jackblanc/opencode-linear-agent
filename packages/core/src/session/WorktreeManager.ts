import { $ } from "bun";
import { Result } from "better-result";
import type { GitService } from "../git/GitService";
import type { LinearService } from "../linear/LinearService";
import type { SessionRepository } from "./SessionRepository";
import type { Logger } from "../logger";

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
 * - Creating new worktrees from origin/main via GitService
 */
export class WorktreeManager {
  constructor(
    private readonly git: GitService,
    private readonly linear: LinearService,
    private readonly repository: SessionRepository,
    private readonly repoDirectory: string,
    private readonly startCommand?: string,
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

    // No existing worktree - create one from origin/main via GitService
    await this.linear.postStageActivity(linearSessionId, "git_setup");

    log.info("Creating worktree from origin", {
      repoDirectory: this.repoDirectory,
    });

    const worktreeResult = await this.git.createWorktreeFromOrigin(
      this.repoDirectory,
      issue,
      log,
    );

    if (Result.isError(worktreeResult)) {
      log.error("Error creating worktree", {
        error: worktreeResult.error.message,
        errorType: worktreeResult.error._tag,
      });
      return Result.err(worktreeResult.error);
    }

    const workdir = worktreeResult.value.directory;
    const branchName = worktreeResult.value.branch;

    // Run start command if provided (e.g., "bun install")
    if (this.startCommand) {
      log.info("Running start command", { command: this.startCommand });
      const startResult = await this.runStartCommand(
        workdir,
        this.startCommand,
      );
      if (!startResult.success) {
        log.warn("Start command failed", {
          command: this.startCommand,
          error: startResult.error,
        });
        // Don't fail the worktree creation - log and continue
      }
    }

    log.info("Worktree created", {
      workdir,
      branchName,
    });

    return Result.ok({
      workdir,
      branchName,
      source: "created" as const,
    });
  }

  /**
   * Run a start command in the worktree directory
   */
  private async runStartCommand(
    directory: string,
    command: string,
  ): Promise<{ success: boolean; error?: string }> {
    const result =
      process.platform === "win32"
        ? await $`cmd /c ${command}`.nothrow().cwd(directory).quiet()
        : await $`bash -lc ${command}`.nothrow().cwd(directory).quiet();

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.toString() || result.stdout.toString(),
      };
    }

    return { success: true };
  }
}
