import type {
  GitOperations,
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
  console.info(`[${context}] Executing command: ${command}`);

  let result: ExecResult;
  try {
    result = await sandbox.exec(organizationId, command, { timeout });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[${context}] Command threw exception after ${elapsed}ms: ${errorMessage}`,
    );
    throw error;
  }

  const elapsed = Date.now() - startTime;

  if (result.exitCode !== 0) {
    console.error(
      `[${context}] Command failed after ${elapsed}ms with exit code ${result.exitCode}`,
    );
    if (result.stderr) {
      console.error(`[${context}] stderr: ${result.stderr}`);
    }
    if (result.stdout) {
      console.info(`[${context}] stdout: ${result.stdout}`);
    }
    throw new Error(
      `Command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
    );
  }

  console.info(`[${context}] Command succeeded in ${elapsed}ms`);
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

  async ensureRepoCloned(): Promise<void> {
    console.info(`[clone] Checking if main repo exists at ${REPO_DIR}`);
    const repoExists = await this.sandbox.exists(
      this.organizationId,
      `${REPO_DIR}/.git`,
    );

    if (repoExists) {
      console.info(`[clone] Main repository already cloned at ${REPO_DIR}`);
      return;
    }

    console.info(`[clone] Cloning repository to ${REPO_DIR}`);
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

    console.info(`[clone] Main repository cloned successfully to ${REPO_DIR}`);
  }

  async ensureWorktree(
    sessionId: string,
    issueId: string,
    existingBranch?: string,
  ): Promise<WorktreeInfo> {
    const workdir = getSessionWorkdir(sessionId);
    const branchName =
      existingBranch ?? `linear-opencode-agent/${issueId}/${sessionId}`;

    console.info(
      `[worktree] Starting worktree setup for session ${sessionId}, workdir: ${workdir}, branch: ${branchName}`,
    );

    // Step 1: Ensure main repo is cloned
    await this.ensureRepoCloned();

    // Step 2: Check if worktree already exists
    const worktreeExists = await this.sandbox.exists(
      this.organizationId,
      `${workdir}/.git`,
    );

    if (worktreeExists) {
      console.info(`[worktree] Worktree already exists at ${workdir}`);
      return { workdir, branchName };
    }

    // Step 3: Create sessions directory
    await execWithLogging(
      this.sandbox,
      this.organizationId,
      "mkdir -p /workspace/sessions",
      30000,
      "worktree-mkdir",
    );

    // Step 4: Check if branch exists on remote
    const branchExistsResult = await this.sandbox.exec(
      this.organizationId,
      `cd ${REPO_DIR} && git fetch origin ${branchName} 2>/dev/null && echo "exists" || echo "new"`,
      { timeout: 60000 },
    );
    const branchExists = branchExistsResult.stdout.trim() === "exists";
    console.info(
      `[worktree] Branch ${branchName} exists on remote: ${branchExists}`,
    );

    // Step 5: Create worktree
    if (branchExists) {
      console.info(
        `[worktree] Resuming from existing remote branch: ${branchName}`,
      );
      await execWithLogging(
        this.sandbox,
        this.organizationId,
        `cd ${REPO_DIR} && git worktree add ${workdir} origin/${branchName}`,
        60000,
        "worktree-add-existing",
      );
    } else {
      console.info(`[worktree] Creating new branch: ${branchName}`);
      await execWithLogging(
        this.sandbox,
        this.organizationId,
        `cd ${REPO_DIR} && git worktree add -b ${branchName} ${workdir}`,
        60000,
        "worktree-add-new",
      );
    }

    // Step 6: Configure git user and remote
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
    await execWithLogging(
      this.sandbox,
      this.organizationId,
      `cd ${workdir} && bun install`,
      120000,
      "worktree-bun-install",
    );

    console.info(
      `[worktree] Session worktree created successfully at ${workdir} on branch ${branchName}`,
    );
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
      console.error(`[git] Error checking git status: ${errorMessage}`);
      return {
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
        branchName: "unknown",
      };
    }
  }
}
