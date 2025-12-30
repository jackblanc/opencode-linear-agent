import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { LinearClient } from "@linear/sdk";
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { getConfig } from "./config";

const PROJECT_DIR = "/home/user/project";

// Port used by OpenCode server (default)
const OPENCODE_PORT = 4096;

// Prefix used in OpenCode session titles to identify Linear sessions
const LINEAR_SESSION_PREFIX = "linear:";

/**
 * Session state stored in KV
 */
interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  lastActivityTime: number;
}

/**
 * Get or create the OpenCode client for an organization.
 * One sandbox/OpenCode instance per organization.
 */
async function getOpencodeClient(
  env: Env,
  organizationId: string,
  accessToken: string,
): Promise<OpencodeClient> {
  // One sandbox per organization - stays warm across requests
  const sandbox = getSandbox(env.Sandbox, `org-${organizationId}`);

  // Explicitly start the container - it may be sleeping or not yet started
  // The SDK's lazy start doesn't always work reliably
  console.info("Starting sandbox container", { organizationId });
  await sandbox.start();
  console.info("Sandbox container started", { organizationId });

  // Ensure project directory exists
  await sandbox.exec(`mkdir -p ${PROJECT_DIR}`, { timeout: 30000 });

  // Set the access token for the Linear plugin (shared across org)
  await sandbox.setEnvVars({
    LINEAR_ACCESS_TOKEN: accessToken,
  });

  // Get or create OpenCode server (reuses existing if already running)
  const { client } = await createOpencode<OpencodeClient>(sandbox, {
    port: OPENCODE_PORT,
    directory: PROJECT_DIR,
    config: getConfig(env),
  });

  return client;
}

/**
 * Get or create OpenCode session for a Linear session
 */
async function getOrCreateSession(
  client: OpencodeClient,
  kv: KVNamespace,
  linearSessionId: string,
): Promise<string> {
  const stateKey = `session:${linearSessionId}`;
  const existingState = await kv.get<SessionState>(stateKey, "json");

  if (existingState?.opencodeSessionId) {
    console.info("Resuming OpenCode session", {
      opencodeSessionId: existingState.opencodeSessionId,
    });

    try {
      const session = await client.session.get({
        path: { id: existingState.opencodeSessionId },
      });

      if (session.data) {
        return session.data.id;
      }
    } catch (error) {
      console.warn("Failed to resume session, creating new one", { error });
    }
  }

  console.info("Creating new OpenCode session");
  // Encode Linear session ID in title so the plugin can look it up
  const session = await client.session.create({
    body: {
      title: `${LINEAR_SESSION_PREFIX}${linearSessionId}`,
    },
  });

  if (!session.data) {
    throw new Error("Failed to create OpenCode session");
  }

  const newState: SessionState = {
    opencodeSessionId: session.data.id,
    linearSessionId,
    lastActivityTime: Date.now(),
  };

  await kv.put(stateKey, JSON.stringify(newState));

  return session.data.id;
}

/**
 * Clone repository into sandbox (checks filesystem, not KV)
 *
 * Fixed: No longer stores state in KV. After container restart,
 * the check will correctly see the repo is missing and re-clone.
 */
async function ensureRepoCloned(
  env: Env,
  organizationId: string,
  linearSessionId: string,
  linearClient: LinearClient,
): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, `org-${organizationId}`);

  // Check if repo already exists in the container filesystem
  try {
    const result = await sandbox.exec(
      `test -d ${PROJECT_DIR}/.git && echo "exists"`,
      {
        timeout: 10000,
      },
    );
    if (result.stdout?.includes("exists")) {
      console.info("Repository already cloned");
      return;
    }
  } catch {
    // Directory doesn't exist, proceed to clone
  }

  // Validate REPO_URL is configured
  const repoUrl = env.REPO_URL;
  if (!repoUrl) {
    throw new Error("REPO_URL environment variable is not configured");
  }

  await linearClient.createAgentActivity({
    agentSessionId: linearSessionId,
    content: {
      type: "thought",
      body: "Cloning repository...",
    },
    ephemeral: true,
  });

  // Validate GITHUB_TOKEN is configured
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN environment variable is not configured");
  }

  // Clone with authentication
  // Note: We use git credential helper to avoid token appearing in command logs
  await sandbox.exec(
    `git config --global credential.helper '!f() { echo "password=${env.GITHUB_TOKEN}"; }; f'`,
    { timeout: 10000 },
  );

  await sandbox.exec(`git clone ${repoUrl} ${PROJECT_DIR}`, {
    timeout: 120000,
  });

  console.info("Repository cloned successfully");
}

/**
 * Check if activity has stop signal
 */
function hasStopSignal(activity: { signal?: string | null }): boolean {
  return activity.signal === "stop";
}

/**
 * Process the agent session event
 */
async function processAgentSessionEvent(
  payload: AgentSessionEventWebhookPayload,
  env: Env,
): Promise<void> {
  console.info("Processing agent session event", {
    action: payload.action,
    sessionId: payload.agentSession.id,
  });

  const organizationId = payload.organizationId;
  if (!organizationId) {
    console.error("No organization ID in webhook");
    return;
  }

  const tokenData = await env.LINEAR_TOKENS.get(
    `org:${organizationId}`,
    "json",
  );
  if (!tokenData) {
    console.error("No access token found for organization", { organizationId });
    return;
  }

  const accessToken = (tokenData as { accessToken: string }).accessToken;
  const linearClient = new LinearClient({ accessToken });
  const linearSessionId = payload.agentSession.id;

  // Send immediate acknowledgment to Linear
  try {
    await linearClient.createAgentActivity({
      agentSessionId: linearSessionId,
      content: {
        type: "thought",
        body: "Starting to work on this...",
      },
      ephemeral: true,
    });
  } catch (error) {
    console.error("Failed to send acknowledgment", { error });
  }

  try {
    // Get OpenCode client (reuses existing sandbox for this org)
    const client = await getOpencodeClient(env, organizationId, accessToken);

    // Get or create OpenCode session for this Linear session
    const opencodeSessionId = await getOrCreateSession(
      client,
      env.LINEAR_TOKENS,
      linearSessionId,
    );

    if (payload.action === "created") {
      console.info("New agent session created");

      // Ensure repo is cloned
      await ensureRepoCloned(
        env,
        organizationId,
        linearSessionId,
        linearClient,
      );

      const prompt = payload.promptContext || "Please help with this issue.";

      console.info("Starting OpenCode prompt", {
        sessionId: opencodeSessionId,
      });

      await client.session.prompt({
        path: { id: opencodeSessionId },
        body: {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
          parts: [{ type: "text", text: prompt }],
        },
      });

      console.info("OpenCode prompt completed");
    } else if (payload.action === "prompted") {
      console.info("Agent prompted with follow-up");

      // Check for stop signal
      if (payload.agentActivity && hasStopSignal(payload.agentActivity)) {
        console.info("Stop signal received, aborting session");

        try {
          await client.session.abort({ path: { id: opencodeSessionId } });

          await linearClient.createAgentActivity({
            agentSessionId: linearSessionId,
            content: {
              type: "response",
              body: "Work stopped as requested.",
            },
          });
        } catch (error) {
          console.error("Failed to abort session", { error });
        }
        return;
      }

      const prompt =
        payload.agentActivity?.content?.body ||
        payload.promptContext ||
        "Please continue.";

      await client.session.prompt({
        path: { id: opencodeSessionId },
        body: {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
          parts: [{ type: "text", text: prompt }],
        },
      });

      console.info("OpenCode prompt completed");
    }
  } catch (error) {
    console.error("Error processing webhook", { error });

    try {
      await linearClient.createAgentActivity({
        agentSessionId: linearSessionId,
        content: {
          type: "error",
          body: `Failed to process request: ${(error as Error).message}`,
        },
      });
    } catch (activityError) {
      console.error("Failed to send error activity", { activityError });
    }
  }
}

/**
 * Main webhook handler
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const webhookClient = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET);

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = request.headers.get("linear-signature");
  if (!signature) {
    return new Response("Missing webhook signature", { status: 400 });
  }

  const rawBody = Buffer.from(await request.arrayBuffer());

  let payload: AgentSessionEventWebhookPayload;
  try {
    const parsed = JSON.parse(rawBody.toString());
    const timestamp = parsed.webhookTimestamp;

    const isValid = webhookClient.verify(rawBody, signature, timestamp);
    if (!isValid) {
      return new Response("Invalid webhook signature", { status: 400 });
    }

    payload = parsed as AgentSessionEventWebhookPayload;
  } catch {
    return new Response("Invalid webhook", { status: 400 });
  }

  if (payload.type !== "AgentSessionEvent") {
    console.info("Ignoring non-AgentSessionEvent", { type: payload.type });
    return new Response("OK", { status: 200 });
  }

  console.info("Webhook received, processing in background", {
    action: payload.action,
    sessionId: payload.agentSession.id,
  });

  // Process in background using waitUntil - Linear webhooks require response within 5s
  // The Durable Object (sandbox) keeps running after waitUntil completes,
  // so the plugin can stream events to Linear
  ctx.waitUntil(
    processAgentSessionEvent(payload, env).catch((error) => {
      console.error("Background processing failed", error);
    }),
  );

  return new Response("OK", { status: 200 });
}
