/**
 * Webhook types for Linear integration
 */

import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { ProcessingStage } from "../linear-service/types";

export type SupportedWebhookPayload =
  | AgentSessionEventWebhookPayload
  | EntityWebhookPayloadWithIssueData;

export function isAgentSessionEventWebhook(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === "AgentSessionEvent";
}

export function isSupportedWebhook(
  payload: LinearWebhookPayload,
): payload is SupportedWebhookPayload {
  return payload.type === "AgentSessionEvent" || payload.type === "Issue";
}

/**
 * Interface for dispatching webhook events to be processed
 *
 * Implementations:
 * - Cloudflare: Sends to a queue for async processing
 * - Local: Calls LinearEventProcessor directly
 */
export interface EventDispatcher {
  /**
   * Dispatch an event for processing
   *
   * @param event - The webhook payload from Linear (AgentSessionEvent, Issue, etc.)
   */
  dispatch(event: SupportedWebhookPayload): Promise<void>;
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
