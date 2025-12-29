import {
  LinearWebhookClient,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_FIELD,
} from "@linear/sdk/webhooks";
import { LinearClient } from "@linear/sdk";

export async function handleWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Get raw body as string
  const body = await request.text();

  // Verify webhook signature
  const signature = request.headers.get(LINEAR_WEBHOOK_SIGNATURE_HEADER);
  if (!signature) {
    console.warn("Missing webhook signature header");
    return new Response("Missing signature header", { status: 400 });
  }

  const webhookClient = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET);

  // Parse and verify webhook
  const payload = webhookClient.parseData(
    Buffer.from(body),
    signature,
    JSON.parse(body)[LINEAR_WEBHOOK_TS_FIELD]
  );

  console.info("Webhook received", {
    type: payload.type,
    action: payload.action,
  });

  // Only handle agent session events
  if (payload.type !== "AgentSession") {
    console.debug("Ignoring non-agent-session webhook");
    return new Response("OK", { status: 200 });
  }

  // Get organization ID from webhook
  const organizationId = payload.organizationId;
  if (!organizationId) {
    console.error("No organization ID in webhook");
    return new Response("Missing organization ID", { status: 400 });
  }

  // Get access token from KV
  const tokenData = await env.LINEAR_TOKENS.get(
    `org:${organizationId}`,
    "json"
  );
  if (!tokenData) {
    console.error("No access token found for organization", { organizationId });
    return new Response("Unauthorized - please complete OAuth setup", {
      status: 401,
    });
  }

  const accessToken = (tokenData as { accessToken: string }).accessToken;
  const client = new LinearClient({ accessToken });

  // Handle different agent session actions
  if (payload.action === "create") {
    // Agent was tagged/assigned - send initial greeting
    const sessionData = payload.data;
    console.info("Agent session created", { sessionId: sessionData.id });

    await client.createAgentActivity({
      agentSessionId: sessionData.id,
      content: {
        type: "response",
        body: "👋 Hello! I'm your Linear OpenCode agent. I'm a minimal implementation right now - just testing the basics!",
      },
    });
  } else if (payload.action === "update") {
    // User sent a message in the agent session
    const sessionData = payload.data;
    const updatedFrom = payload.updatedFrom;

    // Check if promptContext was updated (user sent a message)
    // Type assertion needed as SDK types don't expose promptContext
    const sessionWithPrompt = sessionData as unknown as {
      id: string;
      promptContext?: string;
    };
    const updatedWithPrompt = updatedFrom as unknown as {
      promptContext?: string;
    };

    if (
      updatedWithPrompt?.promptContext !== undefined &&
      sessionWithPrompt.promptContext
    ) {
      console.info("Agent prompted", {
        sessionId: sessionWithPrompt.id,
        message: sessionWithPrompt.promptContext,
      });

      await client.createAgentActivity({
        agentSessionId: sessionWithPrompt.id,
        content: {
          type: "response",
          body: `You said: "${sessionWithPrompt.promptContext}"\n\nI'm just a minimal echo agent for now!`,
        },
      });
    }
  }

  return new Response("OK", { status: 200 });
}
