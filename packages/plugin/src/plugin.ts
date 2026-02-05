/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { isQuestionTool } from "@linear-opencode-agent/core";
import { createLinearService } from "./linear";
import { readAccessToken, getSessionAsync } from "./storage";
import {
  handleEvent,
  handlePermissionAskHook,
  handleQuestionToolHook,
  type Logger,
} from "./orchestrator";
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
     * Fires AFTER state changes occur (e.g., tool enters "running" state).
     */
    event: async ({ event }) => {
      await handleEvent(event, readAccessToken, createLinearService, log);
    },

    /**
     * Hook into tool execution to post question elicitations BEFORE the tool runs.
     * This is a backup for native OpenCode tools - the main path is via the event handler.
     */
    "tool.execute.before": async (ctx, output) => {
      if (!isQuestionTool(ctx.tool)) return;

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

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) {
        log(
          `tool.execute.before: token not found for organizationId=${session.linear.organizationId}`,
        );
        return;
      }

      const linear = createLinearService(token);
      await handleQuestionToolHook(
        ctx.sessionID,
        ctx.callID,
        output.args,
        linear,
        log,
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

      await handlePermissionAskHook(
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
