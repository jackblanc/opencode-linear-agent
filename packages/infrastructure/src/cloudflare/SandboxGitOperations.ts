import type {
  GitOperations,
  GitProgressCallback,
  GitStatus,
  WorktreeInfo,
} from "@linear-opencode-agent/core";
import type { SandboxProvider, ExecResult } from "../types";

/**
 * Main repository directory (source for worktrees)
 */
const REPO_DIR = "/workspace/repo";

/**
 * Get the working directory for a specific session
 */
function getSessionWorkdir(sessionId: string): string {
  return `/workspace/sessions/${sessionId}`;
}

/**
 * Execute a command with comprehensive logging
 */
async function execWithLogging(
  sandbox: SandboxProvider,
  organizationId: string,
  command: string,
  timeout: number,
  context: string,
): Promise<ExecResult> {
  const startTime = Date.now();

  console.info({
    message: "Executing command",
    stage: "git",
    context,
    command: command.replace(
      /https:\/\/[^@]+@github\.com/,
      "https://***@github.com",
    ),
    timeout,
  });

  let result: ExecResult;
  try {
    result = await sandbox.exec(organizationId, command, { timeout });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error({
      message: "Command threw exception",
      stage: "git",
      context,
      error: errorMessage,
      stack: errorStack,
      elapsedMs: elapsed,
    });
    throw error;
  }

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
 * Git operations implementation using the SandboxProvider
 */
export class SandboxGitOperations implements GitOperations {
  constructor(
    private readonly sandbox: SandboxProvider,
    private readonly organizationId: string,
    private readonly repoUrl: string,
    private readonly githubToken: string,
  ) {}

  async ensureRepoCloned(
    _repoUrl: string,
    onProgress?: GitProgressCallback,
  ): Promise<void> {
    await onProgress?.("checking_repo");

    console.info({
      message: "Checking if main repo exists",
      stage: "git",
      repoDir: REPO_DIR,
    });

    const repoExists = await this.sandbox.exists(
      this.organizationId,
      `${REPO_DIR}/.git`,
    );

    if (repoExists) {
      console.info({
        message: "Main repository already cloned",
        stage: "git",
        repoDir: REPO_DIR,
      });
      return;
    }

    await onProgress?.("cloning_repo");

    console.info({
      message: "Cloning repository",
      stage: "git",
      repoUrl: this.repoUrl,
      repoDir: REPO_DIR,
    });

    const authedRepoUrl = this.repoUrl.replace(
      "https://github.com/",
      `https://${this.githubToken}@github.com/`,
    );

    await execWithLogging(
      this.sandbox,
      this.organizationId,
      `mkdir -p ${REPO_DIR}`,
      30000,
      "clone-mkdir",
    );

    await execWithLogging(
      this.sandbox,
      this.organizationId,
      `git clone ${authedRepoUrl} ${REPO_DIR}`,
      120000,
      "clone-git",
    );

    console.info({
      message: "Main repository cloned successfully",
      stage: "git",
      repoDir: REPO_DIR,
    });
  }

  async ensureWorktree(
    sessionId: string,
    issueId: string,
    existingBranch?: string,
    onProgress?: GitProgressCallback,
  ): Promise<WorktreeInfo> {
    const workdir = getSessionWorkdir(sessionId);
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

    // Step 1: Ensure main repo is cloned
    await this.ensureRepoCloned(this.repoUrl, onProgress);

    // Step 2: Check if worktree already exists and is valid
    await onProgress?.("checking_worktree");

    const worktreeDirExists = await this.sandbox.exists(
      this.organizationId,
      `${workdir}/.git`,
    );

    // Check if worktree is registered with git
    const listResult = await this.sandbox.exec(
      this.organizationId,
      `cd ${REPO_DIR} && git worktree list --porcelain`,
      { timeout: 30000 },
    );
    const isWorktreeRegistered = listResult.stdout.includes(workdir);

    if (worktreeDirExists && isWorktreeRegistered) {
      console.info({
        message: "Worktree already exists and is valid",
        stage: "git",
        workdir,
        branchName,
      });
      return { workdir, branchName };
    }

    // Handle corrupted states
    if (worktreeDirExists && !isWorktreeRegistered) {
      console.warn({
        message: "Worktree directory exists but is not registered, removing",
        stage: "git",
        workdir,
      });
      await this.sandbox.exec(this.organizationId, `rm -rf ${workdir}`, {
        timeout: 30000,
      });
    }

    if (!worktreeDirExists && isWorktreeRegistered) {
      console.warn({
        message: "Worktree is registered but directory missing, pruning",
        stage: "git",
        workdir,
      });
      await this.sandbox.exec(
        this.organizationId,
        `cd ${REPO_DIR} && git worktree prune`,
        { timeout: 30000 },
      );
    }

    // Step 3: Create sessions directory
    await execWithLogging(
      this.sandbox,
      this.organizationId,
      "mkdir -p /workspace/sessions",
      30000,
      "worktree-mkdir",
    );

    // Step 4: Check if branch exists locally or on remote
    await onProgress?.("checking_branch");

    // Check if branch exists locally
    const localBranchResult = await this.sandbox.exec(
      this.organizationId,
      `cd ${REPO_DIR} && git rev-parse --verify refs/heads/${branchName} 2>/dev/null && echo "exists" || echo "new"`,
      { timeout: 30000 },
    );
    const branchExistsLocally = localBranchResult.stdout.trim() === "exists";

    // Check if branch exists on remote
    const remoteBranchResult = await this.sandbox.exec(
      this.organizationId,
      `cd ${REPO_DIR} && git fetch origin ${branchName} 2>/dev/null && echo "exists" || echo "new"`,
      { timeout: 60000 },
    );
    const branchExistsOnRemote = remoteBranchResult.stdout.trim() === "exists";

    console.info({
      message: "Checked branch existence",
      stage: "git",
      branchName,
      existsLocally: branchExistsLocally,
      existsOnRemote: branchExistsOnRemote,
    });

    // Step 5: Create worktree
    await onProgress?.("creating_worktree");

    if (branchExistsLocally) {
      console.info({
        message: "Checking out existing local branch",
        stage: "git",
        branchName,
      });
      await execWithLogging(
        this.sandbox,
        this.organizationId,
        `cd ${REPO_DIR} && git worktree add ${workdir} ${branchName}`,
        60000,
        "worktree-add-local",
      );
    } else if (branchExistsOnRemote) {
      console.info({
        message: "Checking out existing remote branch",
        stage: "git",
        branchName,
      });
      await execWithLogging(
        this.sandbox,
        this.organizationId,
        `cd ${REPO_DIR} && git worktree add ${workdir} origin/${branchName}`,
        60000,
        "worktree-add-remote",
      );
    } else {
      console.info({
        message: "Creating new branch",
        stage: "git",
        branchName,
      });
      await execWithLogging(
        this.sandbox,
        this.organizationId,
        `cd ${REPO_DIR} && git worktree add -b ${branchName} ${workdir}`,
        60000,
        "worktree-add-new",
      );
    }

    // Step 6: Configure git user and remote
    await onProgress?.("configuring_git");

    await execWithLogging(
      this.sandbox,
      this.organizationId,
      `cd ${workdir} && git config user.name "Linear OpenCode Agent" && git config user.email "agent@linear.app"`,
      30000,
      "worktree-git-config",
    );

    const authedRepoUrl = this.repoUrl.replace(
      "https://github.com/",
      `https://${this.githubToken}@github.com/`,
    );
    await execWithLogging(
      this.sandbox,
      this.organizationId,
      `cd ${workdir} && git remote set-url origin ${authedRepoUrl}`,
      30000,
      "worktree-remote-url",
    );

    // Step 7: Install dependencies
    await onProgress?.("installing_dependencies");

    await execWithLogging(
      this.sandbox,
      this.organizationId,
      `cd ${workdir} && bun install`,
      120000,
      "worktree-bun-install",
    );

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
      const branchResult = await this.sandbox.exec(
        this.organizationId,
        `cd ${workdir} && git rev-parse --abbrev-ref HEAD`,
        { timeout: 30000 },
      );
      const branchName = branchResult.stdout.trim();

      // Check for uncommitted changes
      const statusResult = await this.sandbox.exec(
        this.organizationId,
        `cd ${workdir} && git status --porcelain`,
        { timeout: 30000 },
      );
      const hasUncommittedChanges = statusResult.stdout.trim().length > 0;

      // Check for unpushed commits
      const unpushedResult = await this.sandbox.exec(
        this.organizationId,
        `cd ${workdir} && git rev-list --count @{u}..HEAD 2>/dev/null || git rev-list --count origin/main..HEAD 2>/dev/null || echo "0"`,
        { timeout: 30000 },
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
      const errorStack = error instanceof Error ? error.stack : undefined;

      console.error({
        message: "Error checking git status",
        stage: "git",
        error: errorMessage,
        stack: errorStack,
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
