/**
 * Local filesystem implementation of GitOperations
 *
 * Uses Bun.spawn to run git commands on the local machine.
 * Creates worktrees from an existing local repository.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitOperations,
  GitProgressCallback,
  GitStatus,
  WorktreeInfo,
} from "@linear-opencode-agent/core";

/**
 * Execute a command using Bun.spawn
 */
async function exec(
  command: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [cmd, ...args] = command;
  const proc = Bun.spawn([cmd, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Execute a command and throw on failure
 */
async function execWithLogging(
  command: string[],
  context: string,
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const startTime = Date.now();

  console.info({
    message: "Executing command",
    stage: "git",
    context,
    command: command.join(" ").replace(/ghp_[a-zA-Z0-9]+/g, "ghp_***"),
  });

  const result = await exec(command, options);
  const elapsed = Date.now() - startTime;

  if (result.exitCode !== 0) {
    console.error({
      message: "Command failed",
      stage: "git",
      context,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      elapsedMs: elapsed,
    });
    throw new Error(
      `Command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
    );
  }

  console.info({
    message: "Command succeeded",
    stage: "git",
    context,
    elapsedMs: elapsed,
  });

  return result;
}

/**
 * Local Git operations implementation
 */
export class LocalGitOperations implements GitOperations {
  constructor(
    private readonly repoPath: string, // e.g., ~/projects/reservations
    private readonly worktreesPath: string, // e.g., ~/opencode-worktrees/sessions
    private readonly githubToken: string,
    private readonly remoteUrl: string, // e.g., https://github.com/jackblanc/reservations
  ) {}

  /**
   * Get the working directory for a specific session
   */
  private getSessionWorkdir(sessionId: string): string {
    return join(this.worktreesPath, sessionId);
  }

  /**
   * No-op for local - repo already exists
   */
  async ensureRepoCloned(
    _repoUrl: string,
    onProgress?: GitProgressCallback,
  ): Promise<void> {
    await onProgress?.("checking_repo");

    console.info({
      message: "Verifying local repository exists",
      stage: "git",
      repoPath: this.repoPath,
    });

    // Check if .git exists (could be a directory or a file for worktrees)
    const gitPath = join(this.repoPath, ".git");
    const gitFile = Bun.file(gitPath);
    const fileExists = await gitFile.exists();

    // Also check if it's a directory using stat
    let dirExists = false;
    if (!fileExists) {
      try {
        const { stat } = await import("node:fs/promises");
        const stats = await stat(gitPath);
        dirExists = stats.isDirectory();
      } catch {
        dirExists = false;
      }
    }

    if (!fileExists && !dirExists) {
      throw new Error(
        `Repository not found at ${this.repoPath}. Please ensure the repo exists locally.`,
      );
    }

    console.info({
      message: "Local repository verified",
      stage: "git",
      repoPath: this.repoPath,
    });
  }

  async ensureWorktree(
    sessionId: string,
    issueId: string,
    existingBranch?: string,
    onProgress?: GitProgressCallback,
  ): Promise<WorktreeInfo> {
    const workdir = this.getSessionWorkdir(sessionId);
    const branchName =
      existingBranch ?? `linear-opencode-agent/${issueId}/${sessionId}`;

    console.info({
      message: "Starting worktree setup",
      stage: "git",
      sessionId,
      issueId,
      workdir,
      branchName,
    });

    // Step 1: Ensure main repo exists
    await this.ensureRepoCloned(this.remoteUrl, onProgress);

    // Step 2: Check if worktree already exists
    await onProgress?.("checking_worktree");

    const worktreeGit = Bun.file(join(workdir, ".git"));
    if (await worktreeGit.exists()) {
      console.info({
        message: "Worktree already exists",
        stage: "git",
        workdir,
        branchName,
      });
      return { workdir, branchName };
    }

    // Step 3: Create worktrees directory
    await mkdir(this.worktreesPath, { recursive: true });

    // Step 4: Fetch latest from remote
    await onProgress?.("checking_branch");

    // Check if branch exists on remote
    const fetchResult = await exec(["git", "fetch", "origin", branchName], {
      cwd: this.repoPath,
    });
    const branchExistsOnRemote = fetchResult.exitCode === 0;

    console.info({
      message: "Checked branch existence on remote",
      stage: "git",
      branchName,
      existsOnRemote: branchExistsOnRemote,
    });

    // Step 5: Create worktree
    await onProgress?.("creating_worktree");

    if (branchExistsOnRemote) {
      console.info({
        message: "Resuming from existing remote branch",
        stage: "git",
        branchName,
      });
      await execWithLogging(
        ["git", "worktree", "add", workdir, `origin/${branchName}`],
        "worktree-add-existing",
        { cwd: this.repoPath },
      );
    } else {
      console.info({
        message: "Creating new branch",
        stage: "git",
        branchName,
      });
      await execWithLogging(
        ["git", "worktree", "add", "-b", branchName, workdir],
        "worktree-add-new",
        { cwd: this.repoPath },
      );
    }

    // Step 6: Configure git user
    await onProgress?.("configuring_git");

    await execWithLogging(
      ["git", "config", "user.name", "Linear OpenCode Agent"],
      "git-config-name",
      { cwd: workdir },
    );

    await execWithLogging(
      ["git", "config", "user.email", "agent@linear.app"],
      "git-config-email",
      { cwd: workdir },
    );

    // Set remote URL with token for push access
    const authedRemoteUrl = this.remoteUrl.replace(
      "https://github.com/",
      `https://${this.githubToken}@github.com/`,
    );
    await execWithLogging(
      ["git", "remote", "set-url", "origin", authedRemoteUrl],
      "git-remote-url",
      { cwd: workdir },
    );

    // Step 7: Install dependencies
    await onProgress?.("installing_dependencies");

    await execWithLogging(["bun", "install"], "bun-install", { cwd: workdir });

    console.info({
      message: "Session worktree created successfully",
      stage: "git",
      workdir,
      branchName,
    });

    return { workdir, branchName };
  }

  async getStatus(workdir: string): Promise<GitStatus> {
    try {
      // Get current branch name
      const branchResult = await exec(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: workdir },
      );
      const branchName = branchResult.stdout.trim();

      // Check for uncommitted changes
      const statusResult = await exec(["git", "status", "--porcelain"], {
        cwd: workdir,
      });
      const hasUncommittedChanges = statusResult.stdout.trim().length > 0;

      // Check for unpushed commits
      const unpushedResult = await exec(
        [
          "sh",
          "-c",
          "git rev-list --count @{u}..HEAD 2>/dev/null || git rev-list --count origin/main..HEAD 2>/dev/null || echo 0",
        ],
        { cwd: workdir },
      );
      const unpushedCount = parseInt(unpushedResult.stdout.trim(), 10);
      const hasUnpushedCommits = unpushedCount > 0;

      return {
        hasUncommittedChanges,
        hasUnpushedCommits,
        branchName,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error({
        message: "Error checking git status",
        stage: "git",
        error: errorMessage,
        workdir,
      });

      return {
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
        branchName: "unknown",
      };
    }
  }
}
