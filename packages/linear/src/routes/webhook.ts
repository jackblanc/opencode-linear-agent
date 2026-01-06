/**
 * Webhook handler for Linear - Cloudflare Workers implementation
 *
 * This is a thin wrapper around the core webhook handler that:
 * - Implements the EventDispatcher interface using Cloudflare Queues
 * - Creates a LinearStatusPoster using LinearClientAdapter
 */

import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import {
  handleWebhook as coreHandleWebhook,
  type EventDispatcher,
  type LinearEventMessage,
  type LinearStatusPoster,
  type ProcessingStage,
  type TokenStore,
} from "@linear-opencode-agent/core";
import { LinearClientAdapter } from "@linear-opencode-agent/infrastructure";

/**
 * Environment bindings required for webhook handling
 */
interface WebhookEnv {
  LINEAR_WEBHOOK_SECRET: string;
  AGENT_QUEUE: Queue<LinearEventMessage>;
}

/**
 * Handle Linear webhook - verify signature and enqueue for processing
 */
export async function handleWebhook(
  request: Request,
  env: WebhookEnv,
  tokenStore: TokenStore,
): Promise<Response> {
  // Create a dispatcher that sends to Cloudflare Queue
  const dispatcher: EventDispatcher = {
    async dispatch(
      event: AgentSessionEventWebhookPayload,
      workerUrl: string,
    ): Promise<void> {
      const message: LinearEventMessage = {
        payload: event,
        workerUrl,
      };
      await env.AGENT_QUEUE.send(message);
    },
  };

  // Create a status poster factory that uses LinearClientAdapter
  const statusPosterFactory = (accessToken: string): LinearStatusPoster => {
    const adapter = new LinearClientAdapter(accessToken);
    return {
      postStageActivity: async (
        sessionId: string,
        stage: ProcessingStage,
      ): Promise<void> => {
        await adapter.postStageActivity(sessionId, stage);
      },
    };
  };

  return coreHandleWebhook(
    request,
    env.LINEAR_WEBHOOK_SECRET,
    tokenStore,
    dispatcher,
    statusPosterFactory,
  );
}
