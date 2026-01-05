/**
 * OpenCode Plugin for Linear Agent Integration
 *
 * This plugin runs inside the OpenCode process and streams activities
 * directly to Linear's API using the official @linear/sdk.
 *
 * Responsibilities (simplified):
 * - Stream tool activities to Linear
 * - Stream text responses to Linear
 * - Report errors
 * - Send Stop signal on session.idle
 * - Sync todos to Linear plan
 *
 * NOT responsible for (moved to EventProcessor):
 * - Git status checking
 * - Continuation prompts
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

// Cache for session ID lookups
const sessionCache = new Map<string, string>();

/**
 * Get Linear client with fresh token
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
 * Send an activity to Linear
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[LINEAR PLUGIN] Failed to send ${content.type} activity: ${errorMessage}`,
    );
  }
}

/**
 * Update Linear agent plan
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[LINEAR PLUGIN] Failed to update plan: ${errorMessage}`);
  }
}

/**
 * Linear Agent Plugin
 */
export const LinearAgentPlugin: Plugin = async ({ client }) => {
  console.log("[LINEAR PLUGIN] Plugin initializing, workdir: " + process.cwd());

  /**
   * Get Linear session ID for an OpenCode session
   */
  async function getLinearSessionId(
    opencodeSessionId: string,
  ): Promise<string | null> {
    const cached = sessionCache.get(opencodeSessionId);
    if (cached) {
      return cached;
    }

    try {
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[LINEAR PLUGIN] Error fetching session ${opencodeSessionId}: ${errorMessage}`,
      );
    }

    return null;
  }

  // Track sent text part IDs to avoid duplicates
  const sentTextParts = new Set<string>();

  // Cache tool args from before hook
  const toolArgsCache = new Map<string, Record<string, unknown>>();

  return {
    // Tool starting - send ephemeral "running" action
    "tool.execute.before": async (input, output) => {
      const args: Record<string, unknown> = Object.assign(
        {},
        typeof output.args === "object" ? output.args : {},
      );

      toolArgsCache.set(input.callID, args);

      const linearClient = getLinearClient();
      if (!linearClient) {
        return;
      }

      const linearSessionId = await getLinearSessionId(input.sessionID);
      if (!linearSessionId) {
        return;
      }

      console.log(`[LINEAR PLUGIN] Tool starting: ${input.tool}`);

      await sendLinearActivity(
        linearClient,
        linearSessionId,
        {
          type: "action",
          action: getToolActionName(input.tool, false),
          parameter: extractToolParameter(input.tool, args),
        },
        true,
      );
    },

    // Tool completed - send persistent action with result
    "tool.execute.after": async (input, output) => {
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

      console.log(`[LINEAR PLUGIN] Tool completed: ${input.tool}`);

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
        false,
      );
    },

    // Text part completed - send intermediate responses
    "experimental.text.complete": async (input, output) => {
      const linearClient = getLinearClient();
      if (!linearClient) {
        return;
      }

      const linearSessionId = await getLinearSessionId(input.sessionID);
      if (!linearSessionId) {
        return;
      }

      if (sentTextParts.has(input.partID)) {
        return;
      }
      if (!output.text.trim()) {
        return;
      }

      console.log(
        `[LINEAR PLUGIN] Text complete (${output.text.length} chars)`,
      );

      await sendLinearActivity(
        linearClient,
        linearSessionId,
        { type: "response", body: output.text },
        false,
      );

      sentTextParts.add(input.partID);
    },

    // Event handler for session lifecycle and todos
    event: async ({ event }) => {
      try {
        if (
          event.type !== "session.error" &&
          event.type !== "session.idle" &&
          event.type !== "todo.updated"
        ) {
          return;
        }

        console.log(`[LINEAR PLUGIN] Event received: ${event.type}`);

        const linearClient = getLinearClient();
        if (!linearClient) {
          console.log(`[LINEAR PLUGIN] No LINEAR_ACCESS_TOKEN, skipping`);
          return;
        }

        // Extract sessionID
        let opencodeSessionId: string | null = null;
        if (event.type === "session.error") {
          opencodeSessionId = event.properties.sessionID ?? null;
        } else if (event.type === "session.idle") {
          opencodeSessionId = event.properties.sessionID;
        } else if (event.type === "todo.updated") {
          opencodeSessionId = event.properties.sessionID;
        }

        if (!opencodeSessionId) {
          console.log(`[LINEAR PLUGIN] No sessionID in event, skipping`);
          return;
        }

        const linearSessionId = await getLinearSessionId(opencodeSessionId);
        if (!linearSessionId) {
          console.log(`[LINEAR PLUGIN] Not a Linear session, skipping`);
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
          console.log(`[LINEAR PLUGIN] Session error: ${errorMessage}`);
          await sendLinearActivity(
            linearClient,
            linearSessionId,
            { type: "error", body: `Session error: ${errorMessage}` },
            false,
          );
        }

        // Handle session idle - just send Stop signal
        // Git checking is now handled by the EventProcessor
        if (event.type === "session.idle") {
          console.log(`[LINEAR PLUGIN] Session idle, sending Stop signal`);
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
          console.log(`[LINEAR PLUGIN] Syncing ${todos.length} todos to plan`);

          const plan = todos.map((todo) => ({
            content: todo.content,
            status: mapTodoStatus(todo.status),
          }));

          await updateLinearPlan(linearClient, linearSessionId, plan);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`[LINEAR PLUGIN] Event handler error: ${errorMessage}`);
      }
    },
  };
};

export default LinearAgentPlugin;
