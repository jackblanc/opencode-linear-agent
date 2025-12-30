/**
 * OpenCode Plugin for Linear Agent Integration
 *
 * This plugin runs inside the OpenCode process and emits events
 * directly to Linear's API using the official @linear/sdk.
 *
 * Session mapping:
 * - OpenCode session titles are prefixed with "linear:" followed by the Linear session ID
 * - The plugin uses the SDK client to look up session titles
 *
 * Environment variable:
 * - LINEAR_ACCESS_TOKEN: OAuth token for Linear API (shared across org)
 *   This is read fresh on each call to handle the case where the token
 *   is set after the plugin initializes.
 */

import { LinearClient } from "@linear/sdk";
import type { Plugin } from "@opencode-ai/plugin";

// Prefix used in OpenCode session titles to identify Linear sessions
const LINEAR_SESSION_PREFIX = "linear:";

// Tool name mapping for friendly action names
const TOOL_ACTION_MAP: Record<string, { action: string; pastTense: string }> = {
  read: { action: "Reading", pastTense: "Read" },
  edit: { action: "Editing", pastTense: "Edited" },
  write: { action: "Creating", pastTense: "Created" },
  bash: { action: "Running", pastTense: "Ran" },
  glob: { action: "Searching files", pastTense: "Searched files" },
  grep: { action: "Searching code", pastTense: "Searched code" },
  task: { action: "Delegating task", pastTense: "Delegated task" },
  todowrite: { action: "Updating plan", pastTense: "Updated plan" },
  todoread: { action: "Reading plan", pastTense: "Read plan" },
};

// Cache for session ID lookups (OpenCode session ID -> Linear session ID)
const sessionCache = new Map<string, string>();

/**
 * Get Linear client with fresh token.
 * Returns null if token is not available.
 */
function getLinearClient(): LinearClient | null {
  const accessToken = process.env.LINEAR_ACCESS_TOKEN;
  if (!accessToken) {
    return null;
  }
  return new LinearClient({ accessToken });
}

/**
 * Get friendly tool action name
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
 * Extract parameter from tool input
 */
function extractToolParameter(
  toolName: string,
  input: Record<string, unknown>,
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
  status: string,
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
 * Send an activity to Linear using the SDK
 */
async function sendLinearActivity(
  linearClient: LinearClient,
  sessionId: string,
  content: {
    type: "thought" | "action" | "response" | "error" | "elicitation";
    body?: string;
    action?: string;
    parameter?: string;
    result?: string;
  },
  ephemeral = false,
): Promise<void> {
  try {
    await linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content,
      ephemeral,
    });
  } catch (error) {
    console.error("[LINEAR PLUGIN] Failed to send activity:", error);
  }
}

/**
 * Update Linear agent plan using the SDK
 */
async function updateLinearPlan(
  linearClient: LinearClient,
  sessionId: string,
  plan: Array<{ content: string; status: string }>,
): Promise<void> {
  try {
    const agentSession = await linearClient.agentSession(sessionId);
    await agentSession.update({ plan });
  } catch (error) {
    console.error("[LINEAR PLUGIN] Failed to update plan:", error);
  }
}

/**
 * Linear Agent Plugin
 */
export const LinearAgentPlugin: Plugin = async ({ client }) => {
  console.log("[LINEAR PLUGIN] Plugin initializing...");

  /**
   * Get Linear session ID for an OpenCode session (with caching)
   */
  async function getLinearSessionId(
    opencodeSessionId: string,
  ): Promise<string | null> {
    // Check cache first
    const cached = sessionCache.get(opencodeSessionId);
    if (cached) {
      return cached;
    }

    try {
      // Fetch session from OpenCode API
      const session = await client.session.get({
        path: { id: opencodeSessionId },
      });

      if (session.data?.title?.startsWith(LINEAR_SESSION_PREFIX)) {
        const linearSessionId = session.data.title.slice(
          LINEAR_SESSION_PREFIX.length,
        );
        sessionCache.set(opencodeSessionId, linearSessionId);
        return linearSessionId;
      }
    } catch (error) {
      console.error("[LINEAR PLUGIN] Error fetching session:", error);
    }

    return null;
  }

  // Track sent parts to avoid duplicates (keyed by part ID)
  const sentParts = new Set<string>();

  return {
    event: async ({ event }) => {
      try {
        // Get Linear client with fresh token
        const linearClient = getLinearClient();
        if (!linearClient) {
          // Token not available yet - silently skip
          return;
        }

        // Get the OpenCode session ID from the event
        const properties = event.properties as Record<string, unknown>;
        const opencodeSessionId = properties?.sessionId as string | undefined;

        if (!opencodeSessionId) {
          return;
        }

        // Look up the corresponding Linear session ID
        const linearSessionId = await getLinearSessionId(opencodeSessionId);
        if (!linearSessionId) {
          // Not a Linear-linked session
          return;
        }

        // Handle message part updates (tool calls, text, etc.)
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

          // Skip if already sent (for non-ephemeral)
          if (sentParts.has(part.id)) {
            return;
          }

          switch (part.type) {
            case "text":
              // Final text response
              await sendLinearActivity(
                linearClient,
                linearSessionId,
                { type: "response", body: part.text },
                false,
              );
              sentParts.add(part.id);
              break;

            case "reasoning":
              // Internal reasoning - ephemeral thought
              await sendLinearActivity(
                linearClient,
                linearSessionId,
                { type: "thought", body: part.text },
                true,
              );
              break;

            case "tool": {
              const tool = part.tool!;
              const state = part.state!;

              if (state.status === "running") {
                // Tool starting - ephemeral action
                await sendLinearActivity(
                  linearClient,
                  linearSessionId,
                  {
                    type: "action",
                    action: getToolActionName(tool, false),
                    parameter: extractToolParameter(tool, state.input),
                  },
                  true,
                );
              } else if (state.status === "completed") {
                // Tool completed - persistent action with result
                const output = state.output || "";
                const result =
                  output.length > 500
                    ? output.slice(0, 500) + "...(truncated)"
                    : output;

                await sendLinearActivity(
                  linearClient,
                  linearSessionId,
                  {
                    type: "action",
                    action: getToolActionName(tool, true),
                    parameter: extractToolParameter(tool, state.input),
                    result,
                  },
                  false,
                );
                sentParts.add(part.id);
              } else if (state.status === "error") {
                // Tool error
                await sendLinearActivity(
                  linearClient,
                  linearSessionId,
                  { type: "error", body: `${tool} failed: ${state.error}` },
                  false,
                );
                sentParts.add(part.id);
              }
              break;
            }

            case "step-start":
              await sendLinearActivity(
                linearClient,
                linearSessionId,
                { type: "thought", body: "Working..." },
                true,
              );
              break;
          }
        }

        // Handle session errors
        if (event.type === "session.error") {
          const error = event.properties as { message?: string };
          await sendLinearActivity(
            linearClient,
            linearSessionId,
            {
              type: "error",
              body: `Session error: ${error.message || "Unknown error"}`,
            },
            false,
          );
        }
      } catch (error) {
        console.error("[LINEAR PLUGIN] Event handler error:", error);
      }
    },

    // Handle todo updates -> sync to Linear plan
    "todo.updated": async (input: {
      sessionId?: string;
      todos?: Array<{ content: string; status: string }>;
    }) => {
      try {
        const linearClient = getLinearClient();
        if (!linearClient) {
          return;
        }

        // Get session ID from input
        const opencodeSessionId = input.sessionId;
        if (!opencodeSessionId) {
          return;
        }

        const linearSessionId = await getLinearSessionId(opencodeSessionId);
        if (!linearSessionId) {
          return;
        }

        const todos = input.todos || [];
        const plan = todos.map((todo) => ({
          content: todo.content,
          status: mapTodoStatus(todo.status),
        }));

        await updateLinearPlan(linearClient, linearSessionId, plan);
      } catch (error) {
        console.error("[LINEAR PLUGIN] Todo update error:", error);
      }
    },
  };
};

export default LinearAgentPlugin;
