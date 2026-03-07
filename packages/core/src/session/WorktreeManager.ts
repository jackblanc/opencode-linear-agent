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
  source: "existing_session" | "existing_issue" | "created";
}

export interface WorktreeIssue {
  id?: string;
  identifier: string;
  branchName?: string;
}

export type SessionWorktreeAction = "created" | "prompted";

export interface SessionCleanupResult {
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  fullyCleaned: boolean;
}

type SessionStateValidationResult =
  | { status: "valid"; repoDirectory: string }
  | { status: "stale" }
  | { status: "inconclusive"; reason: string };

class GitCommandError extends Error {
  readonly exitCode: number | undefined;

  constructor(message: string, exitCode: number | undefined) {
    super(message);
    this.exitCode = exitCode;
  }
}

type BranchState = "exists" | "missing";

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
   * Reuses a valid session worktree first, then a valid issue worktree, then
   * creates a new one.
   */
  async resolveWorktree(
    linearSessionId: string,
    issue: WorktreeIssue,
    _action: SessionWorktreeAction,
    log: Logger,
  ): Promise<Result<WorktreeResolution, Error>> {
    const existingState = await this.repository.get(linearSessionId);
    const issueState = issue.id
      ? await this.repository.getByIssueId(issue.id)
      : null;

    const storedResult = await this.resolveStoredWorktree(
      existingState,
      linearSessionId,
      "session",
      log,
    );
    if (storedResult) {
      return storedResult;
    }

    const issueResult = await this.resolveStoredWorktree(
      this.getReusableIssueState(issueState, linearSessionId),
      linearSessionId,
      "issue",
      log,
    );
    if (issueResult) {
      return issueResult;
    }

    return this.createWorktree(linearSessionId, issue, log);
  }

  /**
   * Remove a worktree and branch for cleanup.
   */
  async cleanupSessionResources(
    state: SessionState,
    log: Logger,
  ): Promise<SessionCleanupResult> {
    if (!state.repoDirectory) {
      log.warn("Session state missing repo directory; skipping cleanup", {
        branchName: state.branchName,
        workdir: state.workdir,
      });
      return {
        worktreeRemoved: false,
        branchRemoved: false,
        fullyCleaned: false,
      };
    }

    const repoDirectory = state.repoDirectory;
    let worktreeRemoved = true;
    let branchRemoved = true;

    if (existsSync(state.workdir)) {
      const removeResult = await this.runGit(repoDirectory, [
        "worktree",
        "remove",
        "--force",
        state.workdir,
      ]);

      if (Result.isError(removeResult)) {
        worktreeRemoved = false;
        log.warn("Failed to remove worktree", {
          workdir: state.workdir,
          error: removeResult.error.message,
        });
      }
    }

    const branchStateResult = await this.getBranchState(
      state.branchName,
      repoDirectory,
    );
    if (Result.isError(branchStateResult)) {
      branchRemoved = false;
      log.warn("Failed to verify branch before cleanup", {
        branchName: state.branchName,
        error: branchStateResult.error.message,
      });
    } else if (branchStateResult.value === "exists") {
      const deleteResult = await this.runGit(repoDirectory, [
        "branch",
        "-D",
        state.branchName,
      ]);
      if (Result.isError(deleteResult)) {
        branchRemoved = false;
        log.warn("Failed to delete branch", {
          branchName: state.branchName,
          error: deleteResult.error.message,
        });
      }
    }

    return {
      worktreeRemoved,
      branchRemoved,
      fullyCleaned: worktreeRemoved && branchRemoved,
    };
  }

  private async createWorktree(
    linearSessionId: string,
    issue: WorktreeIssue,
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

    const worktreeName = this.buildWorktreeName(issue);
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

    const branchResult = await this.ensureBranchName(
      worktreeResult.value.directory,
      worktreeResult.value.branch,
      worktreeName,
      log,
    );

    if (Result.isError(branchResult)) {
      return Result.err(branchResult.error);
    }

    return Result.ok({
      workdir: worktreeResult.value.directory,
      branchName: branchResult.value,
      source: "created" as const,
    });
  }

  private buildWorktreeName(issue: WorktreeIssue): string {
    if (issue.branchName) {
      return issue.branchName;
    }

    return issue.identifier.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }

  private getReusableIssueState(
    state: SessionState | null,
    linearSessionId: string,
  ): SessionState | null {
    if (!state || state.linearSessionId === linearSessionId) {
      return null;
    }

    return state;
  }

  private async resolveStoredWorktree(
    state: SessionState | null,
    linearSessionId: string,
    kind: "session" | "issue",
    log: Logger,
  ): Promise<Result<WorktreeResolution, Error> | null> {
    if (!state) {
      return null;
    }

    const stateResult = await this.validateSessionState(state, log);
    if (stateResult.status === "valid") {
      if (state.repoDirectory !== stateResult.repoDirectory) {
        await this.repository.save({
          ...state,
          repoDirectory: stateResult.repoDirectory,
        });
        log.info("Migrated stored session repo directory", {
          workdir: state.workdir,
          repoDirectory: stateResult.repoDirectory,
        });
      }

      const label = kind === "session" ? "session" : "issue";
      log.info(`Reusing existing ${label} worktree`, {
        workdir: state.workdir,
        branchName: state.branchName,
        linearSessionId: state.linearSessionId,
      });

      return Result.ok({
        workdir: state.workdir,
        branchName: state.branchName,
        source: kind === "session" ? "existing_session" : "existing_issue",
      });
    }

    if (stateResult.status === "inconclusive") {
      if (kind === "issue") {
        log.warn("Issue worktree validation inconclusive, skipping reuse", {
          workdir: state.workdir,
          branchName: state.branchName,
          linearSessionId: state.linearSessionId,
          reason: stateResult.reason,
        });
        return null;
      }

      log.warn(
        "Stored worktree validation inconclusive, preserving session state",
        {
          workdir: state.workdir,
          branchName: state.branchName,
          linearSessionId: state.linearSessionId,
          reason: stateResult.reason,
        },
      );
      return Result.err(new Error(stateResult.reason));
    }

    log.warn("Stored worktree state is stale, clearing state", {
      workdir: state.workdir,
      branchName: state.branchName,
      linearSessionId: state.linearSessionId,
      requestedLinearSessionId: linearSessionId,
    });
    await this.repository.delete(state.linearSessionId);
    return null;
  }

  private async ensureBranchName(
    workdir: string,
    currentBranchName: string,
    expectedBranchName: string,
    log: Logger,
  ): Promise<Result<string, Error>> {
    if (currentBranchName === expectedBranchName) {
      return Result.ok(currentBranchName);
    }

    const renameResult = await this.runGit(workdir, [
      "branch",
      "-m",
      expectedBranchName,
    ]);

    if (Result.isError(renameResult)) {
      log.warn("Failed to rename created branch", {
        workdir,
        currentBranchName,
        expectedBranchName,
        error: renameResult.error.message,
      });
      return Result.err(renameResult.error);
    }

    log.info("Renamed created branch", {
      workdir,
      previousBranchName: currentBranchName,
      branchName: expectedBranchName,
    });

    return Result.ok(expectedBranchName);
  }

  private async validateSessionState(
    state: SessionState,
    log: Logger,
  ): Promise<SessionStateValidationResult> {
    if (!existsSync(state.workdir)) {
      log.warn("Stored workdir does not exist", { workdir: state.workdir });
      return { status: "stale" };
    }

    if (!state.repoDirectory) {
      const migratedRepoDirectory = this.repoDirectory;
      log.info("Migrating legacy session to current repo directory", {
        branchName: state.branchName,
        workdir: state.workdir,
        repoDirectory: migratedRepoDirectory,
      });

      return this.validateBranchForRepo(
        state.branchName,
        migratedRepoDirectory,
        log,
      );
    }

    return this.validateBranchForRepo(
      state.branchName,
      state.repoDirectory,
      log,
    );
  }

  private async validateBranchForRepo(
    branchName: string,
    repoDirectory: string,
    log: Logger,
  ): Promise<SessionStateValidationResult> {
    const branchStateResult = await this.getBranchState(
      branchName,
      repoDirectory,
    );
    if (Result.isError(branchStateResult)) {
      log.warn("Failed to verify stored branch", {
        branchName,
        error: branchStateResult.error.message,
      });
      return {
        status: "inconclusive",
        reason: `Failed to verify branch ${branchName}`,
      };
    }

    if (branchStateResult.value !== "exists") {
      log.warn("Stored branch does not exist", {
        branchName,
      });
      return { status: "stale" };
    }

    return { status: "valid", repoDirectory };
  }

  private async getBranchState(
    branchName: string,
    repoDirectory: string,
  ): Promise<Result<BranchState, Error>> {
    const checkResult = await this.runGit(repoDirectory, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);

    if (Result.isOk(checkResult)) {
      return Result.ok("exists");
    }

    if (checkResult.error instanceof GitCommandError) {
      if (checkResult.error.exitCode === 1) {
        return Result.ok("missing");
      }
    }

    return Result.err(checkResult.error);
  }

  private async runGit(
    repoDirectory: string,
    args: string[],
  ): Promise<Result<void, Error>> {
    try {
      await execFileAsync("git", ["-C", repoDirectory, ...args]);
      return Result.ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let exitCode: number | undefined;

      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "number"
      ) {
        exitCode = error.code;
      }

      return Result.err(new GitCommandError(message, exitCode));
    }
  }
}
