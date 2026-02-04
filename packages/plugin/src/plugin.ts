/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { createLinearService } from "./linear/client";
import { readAccessToken } from "./storage";
import { getSessionAsync } from "./state";
import {
  handleToolPart,
  handleTextPart,
  handleMessageUpdated,
  handleTodoUpdated,
  handleSessionIdle,
  handleSessionError,
  handlePermissionAsk,
  handleQuestionElicitation,
  type Logger,
} from "./handlers";
import { linearTools } from "./tools/index";

export async function LinearPlugin(input: PluginInput): Promise<Hooks> {
  const log: Logger = (message: string) => {
    void input.client.app.log({
      body: {
        service: "linear-plugin",
        level: "error",
        message,
      },
    });
  };

  const info = (message: string, extra?: Record<string, unknown>): void => {
    void input.client.app.log({
      body: {
        service: "linear-plugin",
        level: "info",
        message,
        extra,
      },
    });
  };

  info("Linear plugin initialized (reads session state from file store)");

  return {
    tool: linearTools,

    /**
     * Event handler for streaming OpenCode events to Linear.
     */
    event: async ({ event }) => {
      const props = event.properties as Record<string, unknown>;
      const sessionId =
        "sessionID" in props
          ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sessionID is string when present
            (props.sessionID as string)
          : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- part contains sessionID
            (props.part as { sessionID?: string } | undefined)?.sessionID;

      if (!sessionId) return;

      // Read session from file store
      const session = await getSessionAsync(sessionId);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      if (event.type === "message.part.updated") {
        await handleToolPart(event, linear, log);
        await handleTextPart(event, linear, log);
        return;
      }

      if (event.type === "message.updated") {
        await handleMessageUpdated(event, linear, log);
        return;
      }

      if (event.type === "todo.updated") {
        await handleTodoUpdated(event, linear, log);
        return;
      }

      if (event.type === "session.idle") {
        handleSessionIdle(event);
        return;
      }

      if (event.type === "session.error") {
        await handleSessionError(event, linear, log);
        return;
      }
    },

    /**
     * Hook into tool execution to post question elicitations BEFORE the tool runs.
     * This ensures the elicitation appears in Linear while OpenCode waits for user response.
     */
    "tool.execute.before": async (ctx, output) => {
      const toolLower = ctx.tool.toLowerCase();
      if (toolLower !== "question" && !toolLower.endsWith("_question")) return;

      // Read session from file store
      const session = await getSessionAsync(ctx.sessionID);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      // Post elicitation immediately so it appears in Linear before user answers
      await handleQuestionElicitation(
        ctx.sessionID,
        ctx.callID,
        output.args,
        linear,
        log,
      );
    },

    /**
     * Hook into permission requests to post elicitations.
     */
    "permission.ask": async (ctx: Permission, _output) => {
      // Read session from file store
      const session = await getSessionAsync(ctx.sessionID);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      const patterns = Array.isArray(ctx.pattern)
        ? ctx.pattern
        : ctx.pattern
          ? [ctx.pattern]
          : [];

      await handlePermissionAsk(
        ctx.sessionID,
        ctx.id,
        ctx.type,
        patterns,
        ctx.metadata,
        linear,
        log,
      );
    },
  };
}
