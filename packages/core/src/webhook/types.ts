/**
 * Webhook types for Linear integration
 */

import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { ProcessingStage } from "../linear/types";

/**
 * Interface for dispatching webhook events to be processed
 *
 * Implementations:
 * - Cloudflare: Sends to a queue for async processing
 * - Local: Calls EventProcessor directly
 */
export interface EventDispatcher {
  /**
   * Dispatch an event for processing
   *
   * @param event - The webhook payload from Linear
   */
  dispatch(event: AgentSessionEventWebhookPayload): Promise<void>;
}

/**
 * Interface for posting immediate status updates to Linear
 * Used to acknowledge webhook receipt before async processing
 */
export interface LinearStatusPoster {
  /**
   * Post a stage activity to Linear
   *
   * @param sessionId - Linear session ID
   * @param stage - The processing stage
   */
  postStageActivity(sessionId: string, stage: ProcessingStage): Promise<void>;
}

/**
 * Factory function to create a LinearStatusPoster from an access token
 */
export type LinearStatusPosterFactory = (
  accessToken: string,
) => LinearStatusPoster;
