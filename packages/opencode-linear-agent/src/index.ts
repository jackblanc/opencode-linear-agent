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
 *
 * IMPORTANT: Linear does NOT support streaming. This plugin uses discrete hooks:
 * - tool.execute.before: Send ephemeral "running" action
 * - tool.execute.after: Send persistent "completed" action with result
 * - experimental.text.complete: Send intermediate complete text responses
 * - session.idle: Send final response with Stop signal
 * - session.error: Report errors
 * - todo.updated: Sync plan to Linear
 */

import { LinearClient, AgentActivitySignal } from "@linear/sdk";
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
 * @param signal - Optional signal to send with the activity (e.g., AgentActivitySignal.Stop to end session)
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
  signal?: AgentActivitySignal,
): Promise<void> {
  try {
    await linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content,
      ephemeral,
      signal,
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

  // Track sent text part IDs to avoid duplicates
  const sentTextParts = new Set<string>();

  // Cache tool args from before hook for use in after hook (keyed by callID)
  const toolArgsCache = new Map<string, Record<string, unknown>>();

  return {
    // Tool starting - send ephemeral "running" action
    "tool.execute.before": async (input, output) => {
      // Safely extract args - output.args is typed as `any` from plugin API
      const args: Record<string, unknown> = Object.assign(
        {},
        typeof output.args === "object" ? output.args : {},
      );

      // Cache args for the after hook
      toolArgsCache.set(input.callID, args);

      const linearClient = getLinearClient();
      if (!linearClient) {
        return;
      }

      const linearSessionId = await getLinearSessionId(input.sessionID);
      if (!linearSessionId) {
        return;
      }

      console.log("[LINEAR PLUGIN] Tool starting:", input.tool);

      await sendLinearActivity(
        linearClient,
        linearSessionId,
        {
          type: "action",
          action: getToolActionName(input.tool, false),
          parameter: extractToolParameter(input.tool, args),
        },
        true, // ephemeral
      );
    },

    // Tool completed - send persistent action with result
    "tool.execute.after": async (input, output) => {
      // Get cached args and clean up
      const args = toolArgsCache.get(input.callID) ?? {};
      toolArgsCache.delete(input.callID);

      const linearClient = getLinearClient();
      if (!linearClient) {
        return;
      }

      const linearSessionId = await getLinearSessionId(input.sessionID);
      if (!linearSessionId) {
        return;
      }

      console.log("[LINEAR PLUGIN] Tool completed:", input.tool);

      // Truncate long outputs
      const result =
        output.output.length > 500
          ? output.output.slice(0, 500) + "...(truncated)"
          : output.output;

      await sendLinearActivity(
        linearClient,
        linearSessionId,
        {
          type: "action",
          action: getToolActionName(input.tool, true),
          parameter: extractToolParameter(input.tool, args),
          result,
        },
        false, // persistent
      );
    },

    // Text part completed - send intermediate complete text responses
    // This fires when a text part finishes (e.g., before a tool call)
    "experimental.text.complete": async (input, output) => {
      const linearClient = getLinearClient();
      if (!linearClient) {
        return;
      }

      const linearSessionId = await getLinearSessionId(input.sessionID);
      if (!linearSessionId) {
        return;
      }

      // Skip if already sent
      if (sentTextParts.has(input.partID)) {
        return;
      }

      // Skip empty text
      if (!output.text.trim()) {
        return;
      }

      console.log(
        "[LINEAR PLUGIN] Text complete:",
        output.text.slice(0, 100) + "...",
      );

      await sendLinearActivity(
        linearClient,
        linearSessionId,
        { type: "response", body: output.text },
        false, // persistent
      );

      sentTextParts.add(input.partID);
    },

    // Event handler for session lifecycle and todos
    event: async ({ event }) => {
      try {
        // Only handle events we care about
        if (
          event.type !== "session.error" &&
          event.type !== "session.idle" &&
          event.type !== "todo.updated"
        ) {
          return;
        }

        console.log("[LINEAR PLUGIN] Event received:", event.type);

        const linearClient = getLinearClient();
        if (!linearClient) {
          console.log("[LINEAR PLUGIN] No LINEAR_ACCESS_TOKEN available");
          return;
        }

        // Extract sessionID based on event type
        let opencodeSessionId: string | null = null;
        if (event.type === "session.error") {
          opencodeSessionId = event.properties.sessionID ?? null;
        } else if (event.type === "session.idle") {
          opencodeSessionId = event.properties.sessionID;
        } else if (event.type === "todo.updated") {
          opencodeSessionId = event.properties.sessionID;
        }

        if (!opencodeSessionId) {
          console.log("[LINEAR PLUGIN] No sessionID in event");
          return;
        }

        const linearSessionId = await getLinearSessionId(opencodeSessionId);
        if (!linearSessionId) {
          console.log("[LINEAR PLUGIN] Not a Linear-linked session");
          return;
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

        // Handle session idle (completion) - send Stop signal
        // Note: Text responses are sent via experimental.text.complete hook
        if (event.type === "session.idle") {
          console.log("[LINEAR PLUGIN] Session idle - sending Stop signal");

          // Send Stop signal to mark session as complete
          // We use a thought activity since all text was already sent
          await sendLinearActivity(
            linearClient,
            linearSessionId,
            { type: "thought", body: "Task completed." },
            false,
            AgentActivitySignal.Stop,
          );
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
