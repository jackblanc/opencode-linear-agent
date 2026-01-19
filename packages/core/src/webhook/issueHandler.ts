/**
 * Webhook handler for Linear Issue events
 *
 * Handles issue state changes to trigger worktree cleanup when issues
 * move to completed or canceled states.
 */

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  EntityWebhookPayloadWithIssueData,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import { Log } from "../logger";

/**
 * Workflow state types that indicate completion
 */
const COMPLETED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Type guard for Issue webhook payload
 */
export function isIssueEvent(
  payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithIssueData {
  return payload.type === "Issue";
}

/**
 * Check if issue state change indicates completion
 */
export function isCompletedStateChange(
  payload: EntityWebhookPayloadWithIssueData,
): boolean {
  if (payload.action !== "update") {
    return false;
  }

  const stateType = payload.data.state?.type;
  if (!stateType) {
    return false;
  }

  return COMPLETED_STATE_TYPES.has(stateType);
}

/**
 * Interface for handling worktree cleanup
 */
export interface WorktreeCleanupHandler {
  cleanup(issueIdentifier: string): Promise<void>;
}

/**
 * Handle Linear Issue webhook for worktree cleanup
 *
 * @param request - The incoming HTTP request
 * @param webhookSecret - Linear webhook secret for signature verification
 * @param cleanupHandler - Handler for worktree cleanup
 * @param allowedOrganizationId - Optional organization ID to restrict webhooks
 */
export async function handleIssueWebhook(
  request: Request,
  webhookSecret: string,
  cleanupHandler: WorktreeCleanupHandler,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  const rawBody = (globalThis as any).Buffer.from(arrayBuffer) as {
    toString(): string;
  };
  const bodyText = rawBody.toString();

  let webhookPayload: LinearWebhookPayload;
  try {
    const parsed: { webhookTimestamp?: number } = JSON.parse(bodyText);

    webhookPayload = webhookClient.parseData(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
      rawBody as any,
      signature,
      parsed.webhookTimestamp,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = Log.create({ service: "issue-webhook" });
    log.error("Webhook verification failed", { error: errorMessage });
    return new Response("Invalid webhook", { status: 400 });
  }

  if (!isIssueEvent(webhookPayload)) {
    return new Response("OK", { status: 200 });
  }

  const issueIdentifier = webhookPayload.data.identifier;
  const organizationId = webhookPayload.organizationId;

  const log = Log.create({ service: "issue-webhook" })
    .tag("issue", issueIdentifier)
    .tag("organizationId", organizationId);

  if (allowedOrganizationId && organizationId !== allowedOrganizationId) {
    log.warn("Webhook from unauthorized organization");
    return new Response("Unauthorized organization", { status: 403 });
  }

  log.info("Issue webhook received", {
    action: webhookPayload.action,
    stateType: webhookPayload.data.state?.type,
    stateName: webhookPayload.data.state?.name,
  });

  if (!isCompletedStateChange(webhookPayload)) {
    log.info("Ignoring non-completion state change");
    return new Response("OK", { status: 200 });
  }

  log.info("Issue completed, triggering worktree cleanup");

  setImmediate(() => {
    cleanupHandler.cleanup(issueIdentifier).catch((error) => {
      log.error("Worktree cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  return new Response("OK", { status: 200 });
}
