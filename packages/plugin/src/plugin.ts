/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import type { ToolPart, ToolStateRunning } from "@opencode-ai/sdk/v2";
import { createLinearService } from "./linear";
import { getSessionAsync, readAccessToken } from "./storage";
import { handleEvent } from "./orchestrator";
import { linearTools } from "./tools/index";

export async function LinearPlugin(input: PluginInput): Promise<Hooks> {
  const log = (message: string): void => {
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
     * Fires AFTER state changes occur (e.g., tool enters "running" state).
     */
    event: async ({ event }) => {
      const sessionId = extractSessionId(event);
      if (!sessionId) return;

      const session = await getSessionAsync(sessionId);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);
      await handleEvent(event, linear, info);
    },

    /**
     * Hook into tool execution to post question elicitations BEFORE the tool runs.
     * This is a backup for native OpenCode tools - the main path is via the event handler.
     */
    "tool.execute.before": async (ctx, output) => {
      const toolLower = ctx.tool.toLowerCase();

      if (toolLower !== "question" && !toolLower.endsWith("_question")) {
        return;
      }

      info("tool.execute.before: question tool detected", {
        tool: ctx.tool,
        sessionID: ctx.sessionID,
        callID: ctx.callID,
      });

      const session = await getSessionAsync(ctx.sessionID);
      if (!session) {
        log(
          `tool.execute.before: session not found for sessionID=${ctx.sessionID}`,
        );
        return;
      }

      info("tool.execute.before: session found", {
        linearSessionId: session.linear.sessionId,
        organizationId: session.linear.organizationId,
      });

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) {
        log(
          `tool.execute.before: token not found for organizationId=${session.linear.organizationId}`,
        );
        return;
      }

      const linear = createLinearService(token);
      const input = isRecord(output?.args) ? output.args : {};

      const state: ToolStateRunning = {
        status: "running",
        input,
        time: { start: Date.now() },
      };

      const part: ToolPart = {
        id: ctx.callID,
        sessionID: ctx.sessionID,
        messageID: ctx.callID,
        type: "tool",
        callID: ctx.callID,
        tool: ctx.tool,
        state,
      };

      await handleEvent(
        { type: "message.part.updated", properties: { part } },
        linear,
        info,
      );
    },

    /**
     * Hook into permission requests to post elicitations.
     * Fires BEFORE permission dialog is shown to user.
     */
    "permission.ask": async (ctx: Permission, _output) => {
      info("permission.ask hook fired", {
        type: ctx.type,
        sessionID: ctx.sessionID,
        id: ctx.id,
      });

      // Read session from file store
      const session = await getSessionAsync(ctx.sessionID);
      if (!session) {
        info("permission.ask: session not found", { sessionID: ctx.sessionID });
        return;
      }

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      const patterns = Array.isArray(ctx.pattern)
        ? ctx.pattern
        : ctx.pattern
          ? [ctx.pattern]
          : [];

      const request = {
        id: ctx.id,
        sessionID: ctx.sessionID,
        permission: ctx.type,
        patterns,
        metadata: ctx.metadata,
        always: [],
        tool: ctx.callID
          ? {
              messageID: ctx.messageID,
              callID: ctx.callID,
            }
          : undefined,
      };

      await handleEvent(
        { type: "permission.asked", properties: request },
        linear,
        info,
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSessionId(event: { properties: unknown }): string | null {
  if (!isRecord(event.properties)) return null;
  const sessionID = event.properties["sessionID"];
  if (typeof sessionID === "string") return sessionID;

  const part = event.properties["part"];
  if (isRecord(part)) {
    const partSessionId = part["sessionID"];
    if (typeof partSessionId === "string") return partSessionId;
  }

  return null;
}
