import type { Plugin } from "@opencode-ai/plugin";

/**
 * Commit Guard Plugin
 *
 * Prevents data loss when container stops by ensuring:
 * 1. All changes are committed (no uncommitted changes)
 * 2. Changes are pushed to remote
 *
 * When checks fail, throws an error with the [COMMIT_GUARD] prefix
 * so the outer system can detect it and re-prompt the agent.
 */
export const CommitGuardPlugin: Plugin = async ({ $, worktree }) => {
  // Create a shell scoped to the worktree directory
  const $git = $.cwd(worktree);

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // Safety check: ensure we're in a git repository
        const isGitRepo = await $git`git rev-parse --git-dir`.nothrow();
        if (isGitRepo.exitCode !== 0) {
          // Not in a git repo - skip checks
          return;
        }

        const errors: string[] = [];

        // Step 1: Check for uncommitted changes (staged or unstaged)
        const diffResult = await $git`git diff --quiet`.nothrow();
        const cachedResult = await $git`git diff --cached --quiet`.nothrow();

        if (diffResult.exitCode !== 0 || cachedResult.exitCode !== 0) {
          // Get the actual diff for context
          const diffOutput = await $git`git diff`.text();
          const cachedOutput = await $git`git diff --cached`.text();
          const combinedDiff = [diffOutput, cachedOutput]
            .filter(Boolean)
            .join("\n");

          errors.push(
            `## Uncommitted Changes\n\nYou have uncommitted changes. Commit all changes before stopping.\n\n\`\`\`diff\n${combinedDiff.trim().slice(0, 2000)}\n\`\`\``,
          );
        }

        // Step 2: Check if branch is pushed to remote
        const currentBranch = await $git`git rev-parse --abbrev-ref HEAD`
          .text()
          .then((s: string) => s.trim());
        const localCommit = await $git`git rev-parse HEAD`
          .text()
          .then((s: string) => s.trim());
        const remoteCommit = await $git`git rev-parse origin/${currentBranch}`
          .nothrow()
          .text()
          .then((s: string) => s.trim());

        if (!remoteCommit || localCommit !== remoteCommit) {
          errors.push(
            `## Branch Not Pushed\n\nYour branch \`${currentBranch}\` is not pushed to remote or is behind.\n\n**Data will be lost if container stops!**\n\nPush your changes:\n\`\`\`bash\ngit push -u origin ${currentBranch}\n\`\`\``,
          );
        }

        // Step 3: Get current git status for context
        if (errors.length > 0) {
          const statusOutput = await $git`git status --short`.text();

          const errorMessage = [
            "[COMMIT_GUARD] Cannot stop - data loss risk:\n",
            ...errors,
            "\n## Current Git Status\n\n```\n" + statusOutput.trim() + "\n```",
            "\n---\n",
            "**Action required to prevent data loss:**\n",
            "1. Stage and commit all your changes with a descriptive commit message",
            "2. Push your branch to remote: `git push -u origin <branch>`",
            "\nOnce everything is committed and pushed, you may stop safely.",
          ].join("\n");

          throw new Error(errorMessage);
        }
      }
    },
  };
};
