/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { Result } from "better-result";
import { createLinearService } from "./linear";
import {
  readAccessTokenSafe,
  getSessionAsyncSafe,
  formatStoreReadError,
} from "./storage";
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

  const readTokenForHook = async (
    organizationId: string,
    hook: string,
  ): Promise<string | null> => {
    const tokenResult = await readAccessTokenSafe(organizationId);
    if (Result.isError(tokenResult)) {
      log(`${hook}: ${formatStoreReadError(tokenResult.error)}`);
      return null;
    }
    return tokenResult.value;
  };

  return {
    tool: linearTools,

    /**
     * Event handler for streaming OpenCode events to Linear.
     * Fires AFTER state changes occur (e.g., tool enters "running" state).
     * Also handles question.asked events for Linear elicitations.
     */
    event: async ({ event }) => {
      const result = await Result.tryPromise({
        try: async () => {
          await handleEvent(
            event,
            async (organizationId) =>
              readTokenForHook(organizationId, "event token read failed"),
            createLinearService,
            log,
          );
        },
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      });
      if (Result.isError(result)) {
        log(`event hook failed: ${result.error}`);
      }
    },

    "chat.message": async (ctx, output) => {
      const result = await Result.tryPromise({
        try: async () => {
          await handleUserMessage(
            ctx.sessionID,
            ctx.messageID,
            output.parts,
            async (organizationId) =>
              readTokenForHook(
                organizationId,
                "chat.message token read failed",
              ),
            createLinearService,
            log,
          );
        },
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      });
      if (Result.isError(result)) {
        log(`chat.message hook failed: ${result.error}`);
      }
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

      const sessionResult = await getSessionAsyncSafe(ctx.sessionID);
      if (Result.isError(sessionResult)) {
        log(
          `permission.ask session read failed: ${formatStoreReadError(sessionResult.error)}`,
        );
        return;
      }

      const session = sessionResult.value;
      if (!session) {
        info("permission.ask: session not found", { sessionID: ctx.sessionID });
        return;
      }

      const token = await readTokenForHook(
        session.linear.organizationId,
        "permission.ask token read failed",
      );
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
