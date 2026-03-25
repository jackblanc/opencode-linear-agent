/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state from core-owned file namespaces.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk/v2";
import {
  getStateRootPath,
  LinearServiceImpl,
} from "@opencode-linear-agent/core";
import { createToolTokenProvider } from "./auth";
import { createLinearTools } from "./tools/index";
import { createLinearClientProvider } from "./tools/utils";
import { OpencodeEventProcessor } from "@opencode-linear-agent/core/src/opencode-event-processor/OpencodeEventProcessor";
import { createFileAgentState } from "@opencode-linear-agent/core/src/state/root";

export async function LinearPlugin(input: PluginInput): Promise<Hooks> {
  const log = (message: string) => {
    void input.client.app.log({
      body: {
        service: "linear-plugin",
        level: "error",
        message,
      },
    });
  };

  const getToolToken = await createToolTokenProvider();
  const getToolClient = createLinearClientProvider(getToolToken);

  const opencodeEventProcessor = new OpencodeEventProcessor(
    log,
    createFileAgentState(getStateRootPath()),
    (token) => new LinearServiceImpl(token),
  );

  return {
    tool: createLinearTools(getToolClient),

    /**
     * Event handler for streaming OpenCode events to Linear.
     *
     * OpenCode emits the V2 shape of events, but the plugin is still incorrectly
     * using the V1 SDK types, so we cast to V2 for type accuracy.
     */
    event: async ({ event: _event }) => {
      // THIS IS INTENTIONAL, DO NOT REMOVE IT!!!!!
      // eslint-disable-next-line no-unsafe-type-assertion
      const event = _event as unknown as Event; // Cast to V2 Event type

      const result = await opencodeEventProcessor.processEvent(event);

      if (
        result.isErr() &&
        // This case should really return a TaggedError, but this code will be refactored soon
        !result.error.message.includes("Skipping processing for event")
      ) {
        log(`Failed to process event [${event.type}]: ${result.error}`);
      }
    },
  };
}
