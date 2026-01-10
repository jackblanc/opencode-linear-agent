/**
 * Webhook handlers for Linear integration - platform agnostic
 */

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  AgentSessionEventWebhookPayload,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { TokenStore } from "../storage";
import type { EventDispatcher, LinearStatusPosterFactory } from "./types";
import { Log } from "../logger";

/**
 * Type guard for AgentSessionEvent
 */
function isAgentSessionEvent(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === "AgentSessionEvent";
}

/**
 * Handle Linear webhook - verify signature and dispatch for processing
 *
 * This handler responds quickly (<100ms) by:
 * 1. Verifying the webhook signature
 * 2. Posting immediate status activity to Linear
 * 3. Dispatching the event for async processing
 * 4. Returning 200 OK immediately
 *
 * @param request - The incoming HTTP request
 * @param webhookSecret - Linear webhook secret for signature verification
 * @param tokenStore - Store for OAuth tokens
 * @param dispatcher - Event dispatcher (queue for Cloudflare, direct for local)
 * @param statusPosterFactory - Factory to create Linear status poster from access token
 */
export async function handleWebhook(
  request: Request,
  webhookSecret: string,
  tokenStore: TokenStore,
  dispatcher: EventDispatcher,
  statusPosterFactory?: LinearStatusPosterFactory,
  allowedOrganizationId?: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const webhookClient = new LinearWebhookClient(webhookSecret);

  const signature = request.headers.get("linear-signature");
  if (!signature) {
    return new Response("Missing webhook signature", { status: 400 });
  }

  const arrayBuffer = await request.arrayBuffer();
  // The Linear SDK's parseData method expects a Buffer for signature verification.
  // Buffer is available globally in both Cloudflare Workers and Bun runtimes,
  // but TypeScript doesn't know about it at compile time since we don't have
  // Node.js types. We access it via globalThis and cast to the minimal interface
  // we need. The Linear SDK internally uses crypto.createHmac with this Buffer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  const rawBody = (globalThis as any).Buffer.from(arrayBuffer) as {
    toString(): string;
  };
  const bodyText = rawBody.toString();

  // Parse and verify the webhook payload
  let webhookPayload: LinearWebhookPayload;
  try {
    const parsed: { webhookTimestamp?: number } = JSON.parse(bodyText);

    const log = Log.create({ service: "webhook" });
    log.info("Attempting webhook verification", {
      webhookTimestamp: parsed.webhookTimestamp,
      bodyLength: bodyText.length,
    });

    webhookPayload = webhookClient.parseData(
      // Linear SDK expects Buffer type for HMAC signature verification
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
      rawBody as any,
      signature,
      parsed.webhookTimestamp,
    );

    // Log the full webhook payload for debugging
    log.info("Webhook verified successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const log = Log.create({ service: "webhook" });
    log.error("Webhook verification failed", {
      error: errorMessage,
      stack: errorStack,
    });
    return new Response("Invalid webhook", { status: 400 });
  }

  // Only handle AgentSessionEvent webhooks
  if (!isAgentSessionEvent(webhookPayload)) {
    const log = Log.create({ service: "webhook" });
    log.info("Ignoring non-AgentSessionEvent webhook", {
      webhookType: webhookPayload.type,
    });
    return new Response("OK", { status: 200 });
  }

  const sessionId = webhookPayload.agentSession.id;
  const organizationId = webhookPayload.organizationId;
  const issue =
    webhookPayload.agentSession.issue?.identifier ??
    webhookPayload.agentSession.issueId ??
    "unknown";

  // Create tagged logger for this webhook
  const log = Log.create({ service: "webhook" })
    .tag("issue", issue)
    .tag("sessionId", sessionId)
    .tag("organizationId", organizationId);

  // Check organization ID allowlist if configured
  if (allowedOrganizationId && organizationId !== allowedOrganizationId) {
    log.warn("Webhook from unauthorized organization", {
      allowedOrganizationId,
    });
    return new Response("Unauthorized organization", { status: 403 });
  }

  log.info("Webhook received", { action: webhookPayload.action });

  // Post immediate status activity to Linear
  if (organizationId && statusPosterFactory) {
    const accessToken = await tokenStore.getAccessToken(organizationId);
    if (accessToken) {
      const statusPoster = statusPosterFactory(accessToken);
      await statusPoster.postStageActivity(sessionId, "webhook_received");
    } else {
      log.info("No access token available for webhook activity");
    }
  }

  // Extract worker URL for externalLink
  const workerUrl = new URL(request.url).origin;

  // Dispatch for processing
  await dispatcher.dispatch(webhookPayload, workerUrl);

  log.info("Event dispatched successfully", { action: webhookPayload.action });

  return new Response("OK", { status: 200 });
}
