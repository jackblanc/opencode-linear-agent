import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  AgentSessionEventWebhookPayload,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { LinearEventMessage } from "@linear-opencode-agent/core";
import type { TokenStore } from "@linear-opencode-agent/infrastructure";
import { LinearClientAdapter } from "@linear-opencode-agent/infrastructure";

/**
 * Type guard for AgentSessionEvent
 */
function isAgentSessionEvent(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === "AgentSessionEvent";
}

/**
 * Environment bindings required for webhook handling
 */
interface WebhookEnv {
  LINEAR_WEBHOOK_SECRET: string;
  AGENT_QUEUE: Queue<LinearEventMessage>;
}

/**
 * Handle Linear webhook - verify signature and enqueue for processing
 *
 * This handler responds quickly (<100ms) by:
 * 1. Verifying the webhook signature
 * 2. Posting immediate status activity to Linear
 * 3. Enqueuing the event for async processing
 * 4. Returning 200 OK immediately
 */
export async function handleWebhook(
  request: Request,
  env: WebhookEnv,
  tokenStore: TokenStore,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const webhookClient = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET);

  const signature = request.headers.get("linear-signature");
  if (!signature) {
    return new Response("Missing webhook signature", { status: 400 });
  }

  const rawBody = Buffer.from(await request.arrayBuffer());

  // Parse and verify the webhook payload
  let webhookPayload: LinearWebhookPayload;
  try {
    const parsed: { webhookTimestamp?: number } = JSON.parse(
      rawBody.toString(),
    );
    webhookPayload = webhookClient.parseData(
      rawBody,
      signature,
      parsed.webhookTimestamp,
    );
  } catch {
    return new Response("Invalid webhook", { status: 400 });
  }

  // Only handle AgentSessionEvent webhooks
  if (!isAgentSessionEvent(webhookPayload)) {
    console.info({
      message: "Ignoring non-AgentSessionEvent webhook",
      webhookType: webhookPayload.type,
      stage: "webhook",
    });
    return new Response("OK", { status: 200 });
  }

  const sessionId = webhookPayload.agentSession.id;
  const organizationId = webhookPayload.organizationId;
  const issueId =
    webhookPayload.agentSession.issue?.id ??
    webhookPayload.agentSession.issueId ??
    "unknown";

  console.info({
    message: "Webhook received",
    stage: "webhook",
    action: webhookPayload.action,
    linearSessionId: sessionId,
    issueId,
    organizationId,
  });

  // Post immediate status activity to Linear
  if (organizationId) {
    const accessToken = await tokenStore.getAccessToken(organizationId);
    if (accessToken) {
      const linearAdapter = new LinearClientAdapter(accessToken);
      await linearAdapter.postStageActivity(sessionId, "webhook_received");
    } else {
      console.info({
        message: "No access token available for webhook activity",
        stage: "webhook",
        linearSessionId: sessionId,
        organizationId,
      });
    }
  }

  // Extract worker URL for externalLink
  const workerUrl = new URL(request.url).origin;

  // Enqueue for async processing by the agent worker
  const message: LinearEventMessage = {
    payload: webhookPayload,
    workerUrl,
  };

  await env.AGENT_QUEUE.send(message);

  console.info({
    message: "Event enqueued successfully",
    stage: "webhook",
    action: webhookPayload.action,
    linearSessionId: sessionId,
    issueId,
    organizationId,
  });

  return new Response("OK", { status: 200 });
}
