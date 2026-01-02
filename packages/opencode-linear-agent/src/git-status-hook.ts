/**
 * OpenCode Plugin for Git Status Check on Session Idle
 *
 * This plugin runs inside the OpenCode process and checks for untracked
 * or uncommitted files when a session goes idle. If there are uncommitted
 * changes, it sends a message back to the agent prompting it to commit
 * and push the changes.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

const execAsync = promisify(exec);

// Working directory for git operations
const PROJECT_DIR = "/home/user/project";

/**
 * Check for untracked or uncommitted files in the repository.
 * Returns a message if there are issues, or null if everything is clean.
 */
async function checkGitStatus(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: PROJECT_DIR,
    });

    if (stdout.trim()) {
      // There are untracked or modified files
      const lines = stdout.trim().split("\n");
      const untracked = lines.filter((line) => line.startsWith("??"));
      const modified = lines.filter(
        (line) => line.startsWith(" M") || line.startsWith("M "),
      );
      const staged = lines.filter(
        (line) =>
          line.startsWith("A ") ||
          line.startsWith("M ") ||
          line.startsWith("D "),
      );

      if (untracked.length > 0 || modified.length > 0 || staged.length > 0) {
        return "Stop hook feedback:\n[git-status-check]: There are untracked files in the repository. Please commit and push these changes to the remote branch.";
      }
    }

    return null;
  } catch (error) {
    console.error("[GIT STATUS HOOK] Error checking git status:", error);
    return null;
  }
}

/**
 * Extract sessionID from a session.idle event
 */
function getSessionIdFromEvent(event: Event): string | null {
  if (event.type === "session.idle") {
    return event.properties.sessionID;
  }
  return null;
}

/**
 * Git Status Check Plugin
 */
export const GitStatusHookPlugin: Plugin = async ({ client }) => {
  console.log("[GIT STATUS HOOK] Plugin initializing...");

  return {
    event: async ({ event }) => {
      try {
        // Only handle session.idle events
        if (event.type !== "session.idle") {
          return;
        }

        console.log("[GIT STATUS HOOK] Session idle - checking git status");

        const sessionId = getSessionIdFromEvent(event);
        if (!sessionId) {
          console.log("[GIT STATUS HOOK] No sessionID found in event");
          return;
        }

        // Check for untracked/uncommitted files
        const gitStatusMessage = await checkGitStatus();
        if (gitStatusMessage) {
          console.log("[GIT STATUS HOOK] Untracked files detected, prompting agent");

          // Send the feedback message to the agent
          await client.session.promptAsync({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text", text: gitStatusMessage }],
            },
          });

          console.log("[GIT STATUS HOOK] Prompt sent to agent");
        } else {
          console.log("[GIT STATUS HOOK] Repository is clean");
        }
      } catch (error) {
        console.error("[GIT STATUS HOOK] Event handler error:", error);
      }
    },
  };
};

export default GitStatusHookPlugin;
