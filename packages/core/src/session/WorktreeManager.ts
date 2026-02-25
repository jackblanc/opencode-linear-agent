import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { Result } from "better-result";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { LinearService } from "../linear/LinearService";
import type { SessionRepository } from "./SessionRepository";
import type { Logger } from "../logger";
import type { SessionState } from "./SessionState";
import { detectInstallCommand } from "../utils/package-manager";

const execFileAsync = promisify(execFile);

/**
 * Result from resolving a worktree
 */
export interface WorktreeResolution {
  workdir: string;
  branchName: string;
  source: "existing_session" | "created";
}

export type SessionWorktreeAction = "created" | "prompted";

/**
 * Manages worktree creation and cleanup logic.
 */
export class WorktreeManager {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
    private readonly repository: SessionRepository,
    private readonly repoDirectory: string,
  ) {}

  /**
   * Resolve or create a worktree for a session.
   *
   * - `created`: always create a new worktree/branch.
   * - `prompted`: reuse only this session's worktree when valid.
   */
  async resolveWorktree(
    linearSessionId: string,
    issue: string,
    action: SessionWorktreeAction,
    log: Logger,
  ): Promise<Result<WorktreeResolution, Error>> {
    const existingState = await this.repository.get(linearSessionId);

    switch (action) {
      case "prompted":
        if (existingState) {
          const validState = await this.validateSessionState(
            existingState,
            log,
          );
          if (validState) {
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

          log.warn("Stored worktree state is stale, clearing state", {
            workdir: existingState.workdir,
            branchName: existingState.branchName,
          });
          await this.repository.delete(linearSessionId);
        }
        return this.createWorktree(linearSessionId, issue, log);
      case "created":
        return this.createWorktree(linearSessionId, issue, log);
    }
  }

  /**
   * Remove a worktree and branch for cleanup.
   */
  async cleanupSessionResources(
    state: SessionState,
    log: Logger,
  ): Promise<void> {
    const repoDirectory = state.repoDirectory || this.repoDirectory;

    if (existsSync(state.workdir)) {
      const removeResult = await this.runGit(repoDirectory, [
        "worktree",
        "remove",
        "--force",
        state.workdir,
      ]);

      if (Result.isError(removeResult)) {
        log.warn("Failed to remove worktree", {
          workdir: state.workdir,
          error: removeResult.error.message,
        });
      }
    }

    const hasBranch = await this.branchExists(state.branchName, repoDirectory);
    if (hasBranch) {
      const deleteResult = await this.runGit(repoDirectory, [
        "branch",
        "-D",
        state.branchName,
      ]);
      if (Result.isError(deleteResult)) {
        log.warn("Failed to delete branch", {
          branchName: state.branchName,
          error: deleteResult.error.message,
        });
      }
    }
  }

  private async createWorktree(
    linearSessionId: string,
    issue: string,
    log: Logger,
  ): Promise<Result<WorktreeResolution, Error>> {
    await this.linear.postStageActivity(linearSessionId, "git_setup");

    log.info("Creating worktree via OpenCode", {
      repoDirectory: this.repoDirectory,
    });

    const installCommand = detectInstallCommand(this.repoDirectory);
    if (installCommand) {
      log.info("Detected package manager", { installCommand });
    } else {
      log.info("No lockfile found, skipping dependency installation");
    }

    const worktreeName = this.buildWorktreeName(issue, linearSessionId);
    const worktreeResult = await this.opencode.createWorktree(
      this.repoDirectory,
      worktreeName,
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
      worktreeName,
    });

    return Result.ok({
      workdir: worktreeResult.value.directory,
      branchName: worktreeResult.value.branch,
      source: "created" as const,
    });
  }

  private buildWorktreeName(issue: string, linearSessionId: string): string {
    const safeIssue = issue.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const sessionSuffix = linearSessionId.slice(0, 8).toLowerCase();
    return `${safeIssue}-${sessionSuffix}`;
  }

  private async validateSessionState(
    state: SessionState,
    log: Logger,
  ): Promise<boolean> {
    if (!existsSync(state.workdir)) {
      log.warn("Stored workdir does not exist", { workdir: state.workdir });
      return false;
    }

    const repoDirectory = state.repoDirectory || this.repoDirectory;
    const branchExists = await this.branchExists(
      state.branchName,
      repoDirectory,
    );
    if (!branchExists) {
      log.warn("Stored branch does not exist", {
        branchName: state.branchName,
      });
      return false;
    }

    return true;
  }

  private async branchExists(
    branchName: string,
    repoDirectory: string,
  ): Promise<boolean> {
    const checkResult = await this.runGit(repoDirectory, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);
    return Result.isOk(checkResult);
  }

  private async runGit(
    repoDirectory: string,
    args: string[],
  ): Promise<Result<void, Error>> {
    try {
      await execFileAsync("git", ["-C", repoDirectory, ...args]);
      return Result.ok(undefined);
    } catch (error) {
      return Result.err(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
