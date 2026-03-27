/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads session state from core-owned file namespaces.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk/v2";
import {
  AuthRepository,
  LinearService,
  OpencodeEventProcessor,
  createFileAgentState,
  loadApplicationConfig,
} from "@opencode-linear-agent/core";
import { createLinearTools } from "./tools/index";
import { Result } from "better-result";
import { LinearClient } from "@linear/sdk";

export async function LinearPlugin({ client }: PluginInput): Promise<Hooks> {
  const agentState = createFileAgentState();
  const authRepository = new AuthRepository(agentState);

  async function getLinearToolClient() {
    const applicationConfig = loadApplicationConfig();
    if (!applicationConfig.linearOrganizationId) {
      return Result.err(
        "applicationConfig is missing linearOrganizationId, please set linearOrganizationId to enable plugin's Linear tools",
      );
    }

    const token = await authRepository.getAccessToken(
      applicationConfig.linearOrganizationId,
    );
    if (!token) {
      return Result.err(
        `Failed to find accessToken for Linear organization ${applicationConfig.linearOrganizationId}, please re-authenticate OAuth application`,
      );
    }

    return Result.ok(new LinearClient({ accessToken: token }));
  }

  const opencodeEventProcessor = new OpencodeEventProcessor(
    agentState,
    (token) => new LinearService(token),
  );

  return {
    tool: createLinearTools(getLinearToolClient),

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
        await client.app.log({
          body: {
            service: "linear-plugin",
            message: `Failed to process event [${event.type}]: ${result.error}`,
            level: "error",
          },
        });
      }
    },
  };
}
