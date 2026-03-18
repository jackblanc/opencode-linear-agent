/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import {
  formatStoreReadError,
  readAccessTokenSafe,
} from "@opencode-linear-agent/core";

import { createLinearService } from "./linear";
import { handleEvent, type Logger } from "./orchestrator";
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
     *
     * OpenCode emits the V2 shape of events, but the plugin is still incorrectly
     * using the V1 SDK types, so we cast to V2 for type accuracy.
     */
    event: async ({ event: _event }) => {
      // eslint-disable-next-line no-unsafe-type-assertion
      const event = _event as unknown as Event; // Cast to V2 Event type
      const result = await Result.tryPromise({
        try: async () => {
          await handleEvent(
            event,
            async (sessionId) => {
              const messages = await input.client.session.messages({
                path: { id: sessionId },
              });
              if (messages.error || !messages.data) {
                return [];
              }
              return messages.data;
            },
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
  };
}
