import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { LinearClient } from "@linear/sdk";

export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const webhookClient = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET);
  const handler = webhookClient.createHandler();

  // Handle agent session events
  handler.on("AgentSessionEvent", async (payload) => {
    console.info("Agent session event received", payload);

    // Get organization ID from webhook
    const organizationId = payload.organizationId;
    if (!organizationId) {
      console.error("No organization ID in webhook");
      return;
    }

    // Get access token from KV
    const tokenData = await env.LINEAR_TOKENS.get(
      `org:${organizationId}`,
      "json",
    );
    if (!tokenData) {
      console.error("No access token found for organization", {
        organizationId,
      });
      return;
    }

    const accessToken = (tokenData as { accessToken: string }).accessToken;
    const client = new LinearClient({ accessToken });

    // Handle different agent session actions
    if (payload.action === "create") {
      // Agent was tagged/assigned - send initial greeting
      const sessionId = payload.agentSession.id;
      console.info("Agent session created", { sessionId });

      await client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "response",
          body: "👋 Hello! I'm your Linear OpenCode agent. I'm a minimal implementation right now - just testing the basics!",
        },
      });
    } else if (payload.action === "update" && payload.agentActivity) {
      // User sent a message in the agent session
      const sessionId = payload.agentSession.id;

      // Check if there's a prompt context (user message)
      if (payload.promptContext) {
        console.info("Agent prompted", {
          sessionId,
          message: payload.promptContext,
        });

        await client.createAgentActivity({
          agentSessionId: sessionId,
          content: {
            type: "response",
            body: `You said: "${payload.promptContext}"\n\nI'm just a minimal echo agent for now!`,
          },
        });
      }
    }
  });

  // Call the handler with the request
  return handler(request);
}
