import type { Plugin } from "@opencode-ai/plugin";

/**
 * Commit Guard Plugin
 *
 * Prevents OpenCode from stopping until:
 * 1. All tests pass (bun run check)
 * 2. All changes are committed (no uncommitted changes)
 * 3. No untracked files exist (or they're in .gitignore)
 * 4. Changes are pushed to remote
 * 5. Pull request is created
 *
 * When any check fails, throws an error with the [COMMIT_GUARD] prefix
 * so the outer system can detect it and re-prompt the agent.
 */
export const CommitGuardPlugin: Plugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const errors: string[] = [];

        // Step 1: Run tests (bun run check)
        // This typically runs typecheck, lint, and tests
        const checkResult = await $`bun run check`.nothrow();
        if (checkResult.exitCode !== 0) {
          const output =
            checkResult.stderr.toString() || checkResult.stdout.toString();
          errors.push(
            `## Tests Failed\n\n\`bun run check\` exited with code ${checkResult.exitCode}:\n\n\`\`\`\n${output.trim()}\n\`\`\``,
          );
        }

        // Step 2: Check for uncommitted changes (staged or unstaged)
        const diffResult = await $`git diff --quiet`.nothrow();
        const cachedResult = await $`git diff --cached --quiet`.nothrow();

        if (diffResult.exitCode !== 0 || cachedResult.exitCode !== 0) {
          // Get the actual diff for context
          const diffOutput = await $`git diff`.text();
          const cachedOutput = await $`git diff --cached`.text();
          const combinedDiff = [diffOutput, cachedOutput]
            .filter(Boolean)
            .join("\n");

          errors.push(
            `## Uncommitted Changes\n\nYou have uncommitted changes. Commit all changes before stopping.\n\n\`\`\`diff\n${combinedDiff.trim().slice(0, 2000)}\n\`\`\``,
          );
        }

        // Step 3: Check for untracked files
        const untracked =
          await $`git ls-files --others --exclude-standard`.text();
        if (untracked.trim()) {
          errors.push(
            `## Untracked Files\n\nThe following files are untracked. Either commit them or add to .gitignore:\n\n\`\`\`\n${untracked.trim()}\n\`\`\``,
          );
        }

        // Step 4: Check if branch is pushed to remote
        const currentBranch = await $`git rev-parse --abbrev-ref HEAD`
          .text()
          .then((s) => s.trim());
        const localCommit = await $`git rev-parse HEAD`
          .text()
          .then((s) => s.trim());
        const remoteCommit = await $`git rev-parse origin/${currentBranch}`
          .nothrow()
          .text()
          .then((s) => s.trim());

        if (!remoteCommit || localCommit !== remoteCommit) {
          errors.push(
            `## Branch Not Pushed\n\nYour branch \`${currentBranch}\` is not pushed to remote or is behind.\n\nPush your changes:\n\`\`\`bash\ngit push -u origin ${currentBranch}\n\`\`\``,
          );
        }

        // Step 5: Check if PR exists for this branch
        const prCheckResult =
          await $`gh pr list --head ${currentBranch} --json number`.nothrow();
        if (prCheckResult.exitCode === 0) {
          const prs = JSON.parse(prCheckResult.stdout.toString());
          if (!Array.isArray(prs) || prs.length === 0) {
            errors.push(
              `## No Pull Request\n\nNo pull request exists for branch \`${currentBranch}\`.\n\nCreate a PR:\n\`\`\`bash\ngh pr create --fill\n\`\`\`\n\nOr with custom title/body:\n\`\`\`bash\ngh pr create --title "..." --body "..."\n\`\`\``,
            );
          }
        }

        // Step 6: Get current git status for context
        if (errors.length > 0) {
          const statusOutput = await $`git status --short`.text();

          const errorMessage = [
            "[COMMIT_GUARD] Cannot stop - issues detected:\n",
            ...errors,
            "\n## Current Git Status\n\n```\n" + statusOutput.trim() + "\n```",
            "\n---\n",
            "Please fix these issues:\n",
            "1. Fix any failing tests and ensure `bun run check` passes",
            "2. Stage and commit all your changes with a descriptive commit message",
            "3. Either commit or .gitignore any untracked files",
            "4. Push your branch to remote: `git push -u origin <branch>`",
            "5. Create a pull request: `gh pr create --fill`",
            "\nOnce everything passes, is committed, pushed, and a PR is created, you may stop.",
          ].join("\n");

          throw new Error(errorMessage);
        }
      }
    },
  };
};
