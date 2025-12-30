/**
 * OpenCode Plugin for Linear Agent Integration
 *
 * This plugin streams OpenCode events to Linear's agent API,
 * allowing real-time progress updates in Linear's UI.
 *
 * Features:
 * - Streams tool calls, responses, and errors to Linear
 * - Syncs OpenCode todos to Linear plans
 * - Uses Linear SDK for type-safe API calls
 *
 * Environment variable:
 * - LINEAR_ACCESS_TOKEN: OAuth token for Linear API
 */

import type { Plugin } from "@opencode-ai/plugin";
import { LinearAgentClient } from "./linear-client";
import {
  TOOL_ACTION_MAP,
  type LinearPluginOptions,
  type LinearPlanStep,
} from "./types";

// Re-export types for consumers
export type { LinearPluginOptions, LinearPlanStep, LinearActivityContent } from "./types";
export { LinearAgentClient } from "./linear-client";

/**
 * Get friendly tool action name for Linear UI
 */
function getToolActionName(toolName: string, completed: boolean): string {
  const mapping = TOOL_ACTION_MAP[toolName.toLowerCase()];
  if (!mapping) {
    return completed
      ? toolName.charAt(0).toUpperCase() + toolName.slice(1)
      : toolName.charAt(0).toUpperCase() + toolName.slice(1) + "ing";
  }
  return completed ? mapping.pastTense : mapping.action;
}

/**
 * Extract the most relevant parameter from tool input
 */
function extractToolParameter(
  toolName: string,
  input: Record<string, unknown>
): string {
  const key = toolName.toLowerCase();
  switch (key) {
    case "read":
    case "edit":
    case "write":
      return (input.filePath as string) || (input.path as string) || "file";
    case "bash":
      return (input.command as string) || "command";
    case "glob":
    case "grep":
      return (input.pattern as string) || "pattern";
    case "task":
      return (input.description as string) || "task";
    default: {
      const firstKey = Object.keys(input)[0];
      return firstKey ? String(input[firstKey]).slice(0, 100) : toolName;
    }
  }
}

/**
 * Map OpenCode todo status to Linear plan status
 */
function mapTodoStatus(
  status: string
): "pending" | "inProgress" | "completed" | "canceled" {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    case "cancelled":
      return "canceled";
    default:
      return "pending";
  }
}

/**
 * Create the Linear OpenCode plugin.
 *
 * @param options - Plugin configuration options
 * @returns OpenCode plugin instance
 *
 * @example
 * ```typescript
 * import { createLinearPlugin } from "@linear-opencode/plugin";
 *
 * // In OpenCode config
 * export default {
 *   plugins: [createLinearPlugin()],
 * };
 * ```
 */
export function createLinearPlugin(options: LinearPluginOptions = {}): Plugin {
  return async ({ client }) => {
    const accessToken = options.accessToken || process.env.LINEAR_ACCESS_TOKEN;
    const sessionPrefix = options.sessionPrefix || "linear:";
    const maxResultLength = options.maxResultLength || 500;
    const debug = options.debug || false;

    if (debug) {
      console.log("[linear-plugin] Initializing...");
      console.log("[linear-plugin] Session prefix:", sessionPrefix);
    }

    if (!accessToken) {
      console.warn(
        "[linear-plugin] No LINEAR_ACCESS_TOKEN found, plugin disabled"
      );
      return {};
    }

    if (debug) {
      console.log(
        "[linear-plugin] Access token found, length:",
        accessToken.length
      );
    }

    const linearClient = new LinearAgentClient(accessToken, debug);

    // Cache for session ID lookups (OpenCode session ID -> Linear session ID)
    const sessionCache = new Map<string, string>();

    // Track sent parts to avoid duplicates
    const sentParts = new Set<string>();

    /**
     * Get Linear session ID for an OpenCode session
     */
    async function getLinearSessionId(
      opencodeSessionId: string
    ): Promise<string | null> {
      // Check cache first
      const cached = sessionCache.get(opencodeSessionId);
      if (cached) {
        return cached;
      }

      try {
        const session = await client.session.get({
          path: { id: opencodeSessionId },
        });

        if (session.data?.title?.startsWith(sessionPrefix)) {
          const linearSessionId = session.data.title.slice(sessionPrefix.length);
          sessionCache.set(opencodeSessionId, linearSessionId);
          return linearSessionId;
        }
      } catch (error) {
        if (debug) {
          console.error("[linear-plugin] Error fetching session:", error);
        }
      }

      return null;
    }

    return {
      /**
       * Handle OpenCode events and stream to Linear
       */
      event: async ({ event }) => {
        try {
          const properties = event.properties as Record<string, unknown>;
          const opencodeSessionId = properties?.sessionId as string | undefined;

          if (!opencodeSessionId) {
            return;
          }

          const linearSessionId = await getLinearSessionId(opencodeSessionId);
          if (!linearSessionId) {
            return;
          }

          // Handle message part updates
          if (event.type === "message.part.updated") {
            const part = event.properties.part as {
              id: string;
              type: string;
              text?: string;
              tool?: string;
              state?: {
                status: string;
                input: Record<string, unknown>;
                output?: string;
                error?: string;
              };
            };

            // Skip if already sent
            if (sentParts.has(part.id)) {
              return;
            }

            switch (part.type) {
              case "text":
                await linearClient.sendResponse(linearSessionId, part.text || "");
                sentParts.add(part.id);
                break;

              case "reasoning":
                await linearClient.sendThought(linearSessionId, part.text || "");
                break;

              case "tool": {
                const tool = part.tool!;
                const state = part.state!;

                if (state.status === "running") {
                  await linearClient.sendAction(
                    linearSessionId,
                    getToolActionName(tool, false),
                    extractToolParameter(tool, state.input),
                    undefined,
                    true // ephemeral
                  );
                } else if (state.status === "completed") {
                  const output = state.output || "";
                  const result =
                    output.length > maxResultLength
                      ? output.slice(0, maxResultLength) + "...(truncated)"
                      : output;

                  await linearClient.sendAction(
                    linearSessionId,
                    getToolActionName(tool, true),
                    extractToolParameter(tool, state.input),
                    result,
                    false // persistent
                  );
                  sentParts.add(part.id);
                } else if (state.status === "error") {
                  await linearClient.sendError(
                    linearSessionId,
                    `${tool} failed: ${state.error}`
                  );
                  sentParts.add(part.id);
                }
                break;
              }

              case "step-start":
                await linearClient.sendThought(linearSessionId, "Working...");
                break;
            }
          }

          // Handle session errors
          if (event.type === "session.error") {
            const error = event.properties as { message?: string };
            await linearClient.sendError(
              linearSessionId,
              `Session error: ${error.message || "Unknown error"}`
            );
          }
        } catch (error) {
          console.error("[linear-plugin] Event handler error:", error);
        }
      },

      /**
       * Sync todos to Linear plan
       */
      "todo.updated": async (input: {
        sessionId?: string;
        todos?: Array<{ content: string; status: string }>;
      }) => {
        try {
          const opencodeSessionId = input.sessionId;
          if (!opencodeSessionId) {
            return;
          }

          const linearSessionId = await getLinearSessionId(opencodeSessionId);
          if (!linearSessionId) {
            return;
          }

          const todos = input.todos || [];
          const plan: LinearPlanStep[] = todos.map((todo) => ({
            content: todo.content,
            status: mapTodoStatus(todo.status),
          }));

          await linearClient.updatePlan(linearSessionId, plan);

          if (debug) {
            console.log(
              "[linear-plugin] Updated plan with",
              plan.length,
              "items"
            );
          }
        } catch (error) {
          console.error("[linear-plugin] Todo sync error:", error);
        }
      },
    };
  };
}

/**
 * Default export for OpenCode plugin loading
 */
export default createLinearPlugin;
