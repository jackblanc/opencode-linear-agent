/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state and OAuth token from shared store file.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk/v2";
import {
  getStateRootPath,
  LinearServiceImpl,
} from "@opencode-linear-agent/core";
import { linearTools } from "./tools/index";
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

  const opencodeEventProcessor = new OpencodeEventProcessor(
    log,
    createFileAgentState(getStateRootPath()),
    (token) => new LinearServiceImpl(token),
  );

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

      opencodeEventProcessor.processEvent(event);
    },
  };
}
