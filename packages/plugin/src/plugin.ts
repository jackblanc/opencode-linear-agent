/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { createLinearService } from "./linear";
import { readAccessToken, getSessionAsync } from "./storage";
import { handleUserMessage } from "./handlers";
import {
  handleEvent,
  handlePermissionAskHook,
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
     * Also handles question.asked events for Linear elicitations.
     */
    event: async ({ event }) => {
      await handleEvent(event, readAccessToken, createLinearService, log);
    },

    "chat.message": async (ctx, output) => {
      await handleUserMessage(
        ctx.sessionID,
        ctx.messageID,
        output.parts,
        readAccessToken,
        createLinearService,
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
