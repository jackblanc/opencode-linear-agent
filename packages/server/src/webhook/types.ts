/**
 * Webhook types for Linear integration
 */

import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";

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
