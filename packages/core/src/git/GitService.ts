import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Result } from "better-result";
import type { GitServiceError } from "../errors/git";
import {
  GitFetchError,
  GitWorktreeError,
  GitDefaultBranchError,
  GitNotRepoError,
} from "../errors/git";
import type { Logger } from "../logger";

/**
 * Result from creating a worktree
 */
export interface WorktreeResult {
  directory: string;
  branch: string;
}

/**
 * Options for exec helper
 */
interface ExecOptions {
  cwd: string;
  quiet?: boolean;
}

/**
 * Get the XDG data home directory
 */
function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

/**
 * Service for git operations.
 *
 * Handles:
 * - Fetching from origin
 * - Determining the default branch (main/master)
 * - Creating worktrees from origin/main
 */
export class GitService {
  constructor(private readonly worktreeRoot: string) {}

  /**
   * Create a GitService for a repository.
   *
   * Computes the worktree root directory based on the repository's root commit hash,
   * matching OpenCode's worktree storage location: $XDG_DATA_HOME/opencode/worktree/<project-id>/
   *
   * @param repoDir - The repository directory
   * @returns GitService instance or error if project ID cannot be determined
   */
  static async forRepository(
    repoDir: string,
  ): Promise<Result<GitService, GitServiceError>> {
    // Get the root commit hash to use as project ID (matching OpenCode's behavior)
    const result = await $`git rev-list --max-parents=0 --all`
      .quiet()
      .nothrow()
      .cwd(repoDir);

    if (result.exitCode !== 0) {
      return Result.err(new GitNotRepoError({ directory: repoDir }));
    }

    const roots = result.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((x) => x.trim())
      .toSorted();

    const projectId = roots[0];
    if (!projectId) {
      return Result.err(new GitNotRepoError({ directory: repoDir }));
    }

    const worktreeRoot = join(
      getXdgDataHome(),
      "opencode",
      "worktree",
      projectId,
    );
    return Result.ok(new GitService(worktreeRoot));
  }

  /**
   * Fetch the default branch from origin and create a worktree from it.
   *
   * This ensures the worktree is created from the latest origin/main (or origin/master)
   * rather than the local copy which may be stale.
   *
   * @param repoDir - The repository directory
   * @param name - Name for the worktree (used for branch and directory naming)
   * @param log - Logger for debugging
   * @returns WorktreeResult with the directory and branch name
   */
  async createWorktreeFromOrigin(
    repoDir: string,
    name: string,
    log: Logger,
  ): Promise<Result<WorktreeResult, GitServiceError>> {
    // Verify it's a git repo
    const isGitResult = await this.isGitRepo(repoDir);
    if (Result.isError(isGitResult)) {
      return Result.err(isGitResult.error);
    }
    if (!isGitResult.value) {
      return Result.err(new GitNotRepoError({ directory: repoDir }));
    }

    // Determine the default branch
    const defaultBranchResult = await this.getDefaultBranch(repoDir, log);
    if (Result.isError(defaultBranchResult)) {
      return Result.err(defaultBranchResult.error);
    }
    const defaultBranch = defaultBranchResult.value;

    log.info("Fetching origin default branch", {
      branch: defaultBranch,
    });

    // Fetch the default branch from origin
    const fetchResult = await this.fetchBranch(repoDir, defaultBranch, log);
    if (Result.isError(fetchResult)) {
      return Result.err(fetchResult.error);
    }

    // Create the worktree from origin/<defaultBranch>
    const worktreeBranch = `opencode/${this.slugify(name)}`;
    const worktreeDir = join(this.worktreeRoot, this.slugify(name));

    log.info("Creating worktree from origin", {
      branch: worktreeBranch,
      directory: worktreeDir,
      startPoint: `origin/${defaultBranch}`,
    });

    const createResult = await this.createWorktree(
      repoDir,
      worktreeDir,
      worktreeBranch,
      `origin/${defaultBranch}`,
      log,
    );
    if (Result.isError(createResult)) {
      return Result.err(createResult.error);
    }

    return Result.ok({
      directory: worktreeDir,
      branch: worktreeBranch,
    });
  }

  /**
   * Check if a directory is a git repository
   */
  private async isGitRepo(
    dir: string,
  ): Promise<Result<boolean, GitServiceError>> {
    const result = await this.exec(["git", "rev-parse", "--git-dir"], {
      cwd: dir,
      quiet: true,
    });
    return Result.ok(result.exitCode === 0);
  }

  /**
   * Determine the default branch for the repository (main or master)
   *
   * Checks in order:
   * 1. refs/remotes/origin/main
   * 2. refs/remotes/origin/master
   */
  private async getDefaultBranch(
    repoDir: string,
    log: Logger,
  ): Promise<Result<string, GitServiceError>> {
    // Check for origin/main first
    const mainResult = await this.exec(
      ["git", "show-ref", "--verify", "--quiet", "refs/remotes/origin/main"],
      { cwd: repoDir, quiet: true },
    );

    if (mainResult.exitCode === 0) {
      log.debug("Default branch is main");
      return Result.ok("main");
    }

    // Check for origin/master
    const masterResult = await this.exec(
      ["git", "show-ref", "--verify", "--quiet", "refs/remotes/origin/master"],
      { cwd: repoDir, quiet: true },
    );

    if (masterResult.exitCode === 0) {
      log.debug("Default branch is master");
      return Result.ok("master");
    }

    // Neither found - try fetching to see if remote has them
    log.debug("Default branch not found locally, fetching from origin");

    // Fetch without specifying branch to get all refs
    const fetchAllResult = await this.exec(["git", "fetch", "origin"], {
      cwd: repoDir,
      quiet: true,
    });

    if (fetchAllResult.exitCode !== 0) {
      return Result.err(
        new GitDefaultBranchError({
          remote: "origin",
          reason: `Failed to fetch from origin: ${this.getStderr(fetchAllResult)}`,
        }),
      );
    }

    // Re-check for main
    const mainRetryResult = await this.exec(
      ["git", "show-ref", "--verify", "--quiet", "refs/remotes/origin/main"],
      { cwd: repoDir, quiet: true },
    );

    if (mainRetryResult.exitCode === 0) {
      return Result.ok("main");
    }

    // Re-check for master
    const masterRetryResult = await this.exec(
      ["git", "show-ref", "--verify", "--quiet", "refs/remotes/origin/master"],
      { cwd: repoDir, quiet: true },
    );

    if (masterRetryResult.exitCode === 0) {
      return Result.ok("master");
    }

    return Result.err(
      new GitDefaultBranchError({
        remote: "origin",
        reason: "Neither origin/main nor origin/master exists",
      }),
    );
  }

  /**
   * Fetch a specific branch from origin
   */
  private async fetchBranch(
    repoDir: string,
    branch: string,
    log: Logger,
  ): Promise<Result<void, GitServiceError>> {
    log.debug("Fetching branch from origin", { branch });

    const result = await this.exec(["git", "fetch", "origin", branch], {
      cwd: repoDir,
      quiet: true,
    });

    if (result.exitCode !== 0) {
      return Result.err(
        new GitFetchError({
          remote: "origin",
          branch,
          reason: this.getStderr(result) || "Unknown error",
        }),
      );
    }

    return Result.ok(undefined);
  }

  /**
   * Create a git worktree
   *
   * @param repoDir - The main repository directory
   * @param worktreeDir - Directory for the new worktree
   * @param branch - Branch name for the worktree
   * @param startPoint - The commit/ref to start from (e.g., "origin/main")
   * @param log - Logger
   */
  private async createWorktree(
    repoDir: string,
    worktreeDir: string,
    branch: string,
    startPoint: string,
    log: Logger,
  ): Promise<Result<void, GitServiceError>> {
    // Ensure the parent directory exists
    const parentDir = join(worktreeDir, "..");
    await mkdir(parentDir, { recursive: true });

    log.debug("Creating worktree", {
      repoDir,
      worktreeDir,
      branch,
      startPoint,
    });

    // git worktree add -b <branch> <path> <start-point>
    const result = await this.exec(
      ["git", "worktree", "add", "-b", branch, worktreeDir, startPoint],
      { cwd: repoDir, quiet: false },
    );

    if (result.exitCode !== 0) {
      return Result.err(
        new GitWorktreeError({
          branch,
          directory: worktreeDir,
          reason: this.getStderr(result) || "Unknown error",
        }),
      );
    }

    return Result.ok(undefined);
  }

  /**
   * Slugify a string for use in branch names and directory names
   */
  private slugify(input: string): string {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
  }

  /**
   * Execute a git command
   */
  private async exec(
    args: string[],
    options: ExecOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = $`${args}`.cwd(options.cwd).nothrow();
    const result = options.quiet ? await proc.quiet() : await proc;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  }

  /**
   * Get stderr from exec result, falling back to stdout if empty
   */
  private getStderr(result: { stderr: string; stdout: string }): string {
    return result.stderr || result.stdout;
  }
}
