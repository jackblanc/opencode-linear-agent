/**
 * Webhook handlers for Linear integration - platform agnostic
 */

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { LinearWebhookPayload } from "@linear/sdk/webhooks";
import type { EventDispatcher, LinearStatusPosterFactory } from "./types";
import { isAgentSessionEventWebhook, isSupportedWebhook } from "./types";
import { Log } from "../utils/logger";
import type { AuthRepository } from "../state/AuthRepository";

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
 * @param authRepository - Store for OAuth tokens
 * @param dispatcher - Event dispatcher (queue for Cloudflare, direct for local)
 * @param statusPosterFactory - Factory to create Linear status poster from access token
 */
export async function handleWebhook(
  request: Request,
  webhookSecret: string,
  authRepository: AuthRepository,
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
  const rawBody = Buffer.from(arrayBuffer);
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
      rawBody,
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

  // Only handle AgentSessionEvent and Issue webhooks
  if (!isSupportedWebhook(webhookPayload)) {
    const log = Log.create({ service: "webhook" });
    log.info("Ignoring unsupported webhook", {
      webhookType: webhookPayload.type,
    });
    return new Response("OK", { status: 200 });
  }

  const organizationId = webhookPayload.organizationId;
  const sessionId = isAgentSessionEventWebhook(webhookPayload)
    ? webhookPayload.agentSession.id
    : "issue-webhook";
  const issue = isAgentSessionEventWebhook(webhookPayload)
    ? (webhookPayload.agentSession.issue?.identifier ??
      webhookPayload.agentSession.issueId ??
      "unknown")
    : "issue";

  // Create tagged logger for this webhook
  const log = Log.create({ service: "webhook" })
    .tag("issue", issue)
    .tag("sessionId", sessionId)
    .tag("organizationId", organizationId);

  // Check organization ID allowlist if configured
  if (allowedOrganizationId && organizationId !== allowedOrganizationId) {
    log.warn("Webhook from unauthorized organization", {
      organizationId,
      allowedOrganizationId,
    });
    return new Response("Unauthorized organization", { status: 403 });
  }

  const action = webhookPayload.action;
  log.info("Webhook received", {
    action,
    webhookType: webhookPayload.type,
  });

  // Post immediate status activity to Linear
  if (isAgentSessionEventWebhook(webhookPayload) && statusPosterFactory) {
    const accessToken = await authRepository.getAccessToken(organizationId);
    if (accessToken) {
      const statusPoster = statusPosterFactory(accessToken);
      await statusPoster.postStageActivity(sessionId, "webhook_received");
    } else {
      log.info("No access token available for webhook activity");
    }
  }

  // Dispatch for processing in background (fire-and-forget)
  // We return 200 immediately to prevent Linear webhook timeouts and retries.
  // The dispatcher is responsible for error handling and posting errors to Linear.
  setImmediate(() => {
    dispatcher.dispatch(webhookPayload).catch((error) => {
      log.error("Background dispatch failed", {
        action,
        webhookType: webhookPayload.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  log.info("Event dispatched for background processing", {
    action,
    webhookType: webhookPayload.type,
  });

  return new Response("OK", { status: 200 });
}
