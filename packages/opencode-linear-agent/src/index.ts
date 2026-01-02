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
import type { Event, Part, ToolPart } from "@opencode-ai/sdk";

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
 * Safely extract a string from an unknown input object
 */
function getString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
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
      return getString(input, "filePath") ?? getString(input, "path") ?? "file";
    case "bash":
      return getString(input, "command") ?? "command";
    case "glob":
    case "grep":
      return getString(input, "pattern") ?? "pattern";
    case "task":
      return getString(input, "description") ?? "task";
    default: {
      const firstKey = Object.keys(input)[0];
      if (firstKey) {
        const value = input[firstKey];
        return String(value).slice(0, 100);
      }
      return toolName;
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
 * Type guard: check if part is a ToolPart
 */
function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

/**
 * Type guard: check if part has text property
 */
function hasText(part: Part): part is Part & { text: string } {
  return "text" in part && typeof part.text === "string";
}

/**
 * Extract sessionID from an event based on its type.
 * We only handle events that are relevant for Linear integration.
 */
function getSessionIdFromEvent(event: Event): string | null {
  // Only handle events we care about for Linear integration
  // Other event types don't need to be forwarded to Linear
  if (event.type === "message.part.updated") {
    return event.properties.part.sessionID;
  }
  if (event.type === "session.error") {
    return event.properties.sessionID ?? null;
  }
  if (event.type === "session.idle") {
    return event.properties.sessionID;
  }
  if (event.type === "todo.updated") {
    return event.properties.sessionID;
  }
  return null;
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
        console.log("[LINEAR PLUGIN] Event received:", event.type);

        // Get Linear client with fresh token
        const linearClient = getLinearClient();
        if (!linearClient) {
          console.log("[LINEAR PLUGIN] No LINEAR_ACCESS_TOKEN available");
          return;
        }

        // Extract sessionID from the event
        const opencodeSessionId = getSessionIdFromEvent(event);
        if (!opencodeSessionId) {
          console.log(
            "[LINEAR PLUGIN] No sessionID found in event:",
            event.type,
          );
          return;
        }

        console.log(
          "[LINEAR PLUGIN] Processing event for session:",
          opencodeSessionId,
        );

        // Look up the corresponding Linear session ID
        const linearSessionId = await getLinearSessionId(opencodeSessionId);
        if (!linearSessionId) {
          console.log(
            "[LINEAR PLUGIN] Not a Linear-linked session:",
            opencodeSessionId,
          );
          return;
        }

        console.log("[LINEAR PLUGIN] Found Linear session:", linearSessionId);

        // Handle message part updates (tool calls, text, etc.)
        if (event.type === "message.part.updated") {
          const { part, delta } = event.properties;

          console.log("[LINEAR PLUGIN] Part update:", part.type);

          // Skip if already sent (for non-ephemeral)
          if (sentParts.has(part.id)) {
            return;
          }

          if (part.type === "text" && hasText(part)) {
            // Skip streaming updates - only send complete text
            // When delta is present, this is a streaming chunk, not the final content
            if (delta !== undefined) {
              console.log("[LINEAR PLUGIN] Skipping streaming text update");
              return;
            }
            // Final text response (no delta means complete)
            console.log("[LINEAR PLUGIN] Sending complete text response to Linear");
            await sendLinearActivity(
              linearClient,
              linearSessionId,
              { type: "response", body: part.text },
              false,
            );
            sentParts.add(part.id);
          } else if (part.type === "reasoning" && hasText(part)) {
            // Internal reasoning - ephemeral thought
            await sendLinearActivity(
              linearClient,
              linearSessionId,
              { type: "thought", body: part.text },
              true,
            );
          } else if (isToolPart(part)) {
            const { tool, state } = part;

            console.log("[LINEAR PLUGIN] Tool:", tool, "Status:", state.status);

            if (state.status === "running") {
              // Tool starting - ephemeral action
              console.log("[LINEAR PLUGIN] Tool running:", tool);
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
              console.log("[LINEAR PLUGIN] Tool completed:", tool);
              const output = state.output ?? "";
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
              console.log("[LINEAR PLUGIN] Tool error:", tool);
              await sendLinearActivity(
                linearClient,
                linearSessionId,
                {
                  type: "error",
                  body: `${tool} failed: ${state.error ?? "Unknown error"}`,
                },
                false,
              );
              sentParts.add(part.id);
            }
          } else if (part.type === "step-start") {
            await sendLinearActivity(
              linearClient,
              linearSessionId,
              { type: "thought", body: "Working..." },
              true,
            );
          }
        }

        // Handle session errors
        if (event.type === "session.error") {
          const { error } = event.properties;
          let errorMessage = "Unknown error";
          if (
            error &&
            "data" in error &&
            typeof error.data.message === "string"
          ) {
            errorMessage = error.data.message;
          }
          console.log("[LINEAR PLUGIN] Session error:", errorMessage);
          await sendLinearActivity(
            linearClient,
            linearSessionId,
            {
              type: "error",
              body: `Session error: ${errorMessage}`,
            },
            false,
          );
        }

        // Handle session idle (completion)
        if (event.type === "session.idle") {
          console.log("[LINEAR PLUGIN] Session idle - fetching final messages");

          try {
            // Fetch all messages from the session to get complete text
            const messagesResponse = await client.session.messages({
              path: { id: opencodeSessionId },
            });

            if (messagesResponse.data) {
              // Find the last assistant message and extract its text parts
              const messages = messagesResponse.data;
              for (let i = messages.length - 1; i >= 0; i--) {
                const { info, parts } = messages[i];
                if (info.role === "assistant") {
                  // Collect all text parts from this message
                  const textParts = parts
                    .filter(
                      (p): p is Part & { text: string } =>
                        p.type === "text" && hasText(p),
                    )
                    .filter((p) => !sentParts.has(p.id));

                  if (textParts.length > 0) {
                    // Send complete text from all unsent text parts
                    const fullText = textParts.map((p) => p.text).join("\n\n");
                    console.log(
                      "[LINEAR PLUGIN] Sending final message text:",
                      fullText.slice(0, 100) + "...",
                    );
                    await sendLinearActivity(
                      linearClient,
                      linearSessionId,
                      { type: "response", body: fullText },
                      false,
                    );
                    // Mark all as sent
                    textParts.forEach((p) => sentParts.add(p.id));
                  }
                  break; // Only send the last assistant message
                }
              }
            }
          } catch (error) {
            console.error(
              "[LINEAR PLUGIN] Error fetching session messages:",
              error,
            );
            // Fall back to generic completion message
            await sendLinearActivity(
              linearClient,
              linearSessionId,
              { type: "response", body: "Task completed." },
              false,
            );
          }
        }

        // Handle todo updates -> sync to Linear plan
        if (event.type === "todo.updated") {
          const { todos } = event.properties;
          console.log("[LINEAR PLUGIN] Todo updated:", todos.length, "items");

          const plan = todos.map((todo) => ({
            content: todo.content,
            status: mapTodoStatus(todo.status),
          }));

          await updateLinearPlan(linearClient, linearSessionId, plan);
        }
      } catch (error) {
        console.error("[LINEAR PLUGIN] Event handler error:", error);
      }
    },
  };
};

export default LinearAgentPlugin;
