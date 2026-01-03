import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  AgentSessionEventWebhookPayload,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import { LinearClient } from "@linear/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  getOrInitializeSandbox,
  getSandboxInstance,
  REPO_DIR,
  getSessionWorkdir,
} from "./sandbox";

// Prefix used in OpenCode session titles to identify Linear sessions
const LINEAR_SESSION_PREFIX = "linear:";

/**
 * Session state stored in KV
 */
interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  issueId: string;
  branchName: string;
  lastActivityTime: number;
}

/**
 * Result from ensureSessionWorktree
 */
interface WorktreeResult {
  workdir: string;
  branchName: string;
}

/**
 * Type guard to check if payload is an AgentSessionEvent
 */
function isAgentSessionEvent(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === "AgentSessionEvent";
}

/**
 * Result of getOrCreateSession including state for resume handling
 */
interface SessionResult {
  opencodeSessionId: string;
  existingState: SessionState | null;
}

/**
 * Get or create OpenCode session for a Linear session
 */
async function getOrCreateSession(
  client: OpencodeClient,
  kv: KVNamespace,
  linearSessionId: string,
  issueId: string,
  branchName: string,
): Promise<SessionResult> {
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
        return { opencodeSessionId: session.data.id, existingState };
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
    issueId,
    branchName,
    lastActivityTime: Date.now(),
  };

  await kv.put(stateKey, JSON.stringify(newState));

  return { opencodeSessionId: session.data.id, existingState: null };
}

/**
 * Ensure the main repository is cloned to REPO_DIR.
 * This is the source for all worktrees.
 */
async function ensureMainRepoCloned(
  env: Env,
  linearSessionId: string,
  linearClient: LinearClient,
): Promise<void> {
  const sandbox = getSandboxInstance(env);

  // Check if main repo already exists
  const repoExists = await sandbox.exists(`${REPO_DIR}/.git`);
  if (repoExists.exists) {
    console.info("Main repository already cloned");
    return;
  }

  // Validate REPO_URL and GITHUB_TOKEN are configured
  if (!env.REPO_URL) {
    throw new Error("REPO_URL environment variable is not configured");
  }
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN environment variable is not configured");
  }

  await linearClient.createAgentActivity({
    agentSessionId: linearSessionId,
    content: {
      type: "thought",
      body: "Cloning repository...",
    },
    ephemeral: true,
  });

  // Clone with authentication
  const authedRepoUrl = env.REPO_URL.replace(
    "https://github.com/",
    `https://${env.GITHUB_TOKEN}@github.com/`,
  );

  // Clone to REPO_DIR instead of default /workspace
  await sandbox.exec(`mkdir -p ${REPO_DIR}`, { timeout: 30000 });
  await sandbox.exec(`git clone ${authedRepoUrl} ${REPO_DIR}`, {
    timeout: 120000,
  });

  console.info("Main repository cloned successfully");
}

/**
 * Create or resume a session worktree.
 *
 * This function handles:
 * - Cloning the main repo (if needed)
 * - Creating or fetching the session branch
 * - Creating the worktree directory
 * - Configuring git user and remote
 * - Installing dependencies
 */
async function ensureSessionWorktree(
  env: Env,
  linearSessionId: string,
  issueId: string,
  linearClient: LinearClient,
  existingBranch?: string,
): Promise<WorktreeResult> {
  const sandbox = getSandboxInstance(env);
  const workdir = getSessionWorkdir(linearSessionId);
  const branchName =
    existingBranch ?? `linear-opencode-agent/${issueId}/${linearSessionId}`;

  // Ensure main repo is cloned
  await ensureMainRepoCloned(env, linearSessionId, linearClient);

  // Check if worktree already exists
  const worktreeExists = await sandbox.exists(`${workdir}/.git`);
  if (worktreeExists.exists) {
    console.info("Worktree already exists", { workdir });
    return { workdir, branchName };
  }

  await linearClient.createAgentActivity({
    agentSessionId: linearSessionId,
    content: {
      type: "thought",
      body: "Setting up workspace...",
    },
    ephemeral: true,
  });

  // Create sessions directory
  await sandbox.exec("mkdir -p /workspace/sessions", { timeout: 30000 });

  // Check if branch already exists on remote (for resume)
  const branchExistsResult = await sandbox.exec(
    `cd ${REPO_DIR} && git fetch origin ${branchName} 2>/dev/null && echo "exists" || echo "new"`,
    { timeout: 60000 },
  );
  const branchExists = branchExistsResult.stdout.trim() === "exists";

  if (branchExists) {
    // Resume: create worktree from existing remote branch
    console.info("Resuming from existing branch", { branchName });
    await sandbox.exec(
      `cd ${REPO_DIR} && git worktree add ${workdir} origin/${branchName}`,
      { timeout: 60000 },
    );
  } else {
    // New: create worktree with new branch from main
    console.info("Creating new branch", { branchName });
    await sandbox.exec(
      `cd ${REPO_DIR} && git worktree add -b ${branchName} ${workdir}`,
      { timeout: 60000 },
    );
  }

  // Configure git user for the worktree
  await sandbox.exec(
    `cd ${workdir} && git config user.name "Linear OpenCode Agent" && git config user.email "agent@linear.app"`,
    { timeout: 30000 },
  );

  // Set remote URL with auth token for pushing
  if (env.GITHUB_TOKEN && env.REPO_URL) {
    const authedRepoUrl = env.REPO_URL.replace(
      "https://github.com/",
      `https://${env.GITHUB_TOKEN}@github.com/`,
    );
    await sandbox.exec(
      `cd ${workdir} && git remote set-url origin ${authedRepoUrl}`,
      {
        timeout: 30000,
      },
    );
  }

  // Install dependencies
  await linearClient.createAgentActivity({
    agentSessionId: linearSessionId,
    content: {
      type: "thought",
      body: "Installing dependencies...",
    },
    ephemeral: true,
  });

  await sandbox.exec(`cd ${workdir} && bun install`, { timeout: 120000 });

  console.info("Session worktree created successfully", {
    workdir,
    branchName,
  });
  return { workdir, branchName };
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
  workerUrl: string,
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

  // Create Linear client for sending activities
  const accessToken = await env.KV.get(`token:access:${organizationId}`);
  if (!accessToken) {
    console.error("No access token available");
    return;
  }
  const linearClient = new LinearClient({ accessToken });
  const linearSessionId = payload.agentSession.id;

  // Extract issue ID from payload
  const issueId =
    payload.agentSession.issue?.id ?? payload.agentSession.issueId ?? "unknown";

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
    // Set up the session worktree (handles both new and resumed sessions)
    // For resumed sessions, we may need to retrieve the existing branch name
    const stateKey = `session:${linearSessionId}`;
    const existingState = await env.KV.get<SessionState>(stateKey, "json");
    const existingBranch = existingState?.branchName;

    const { workdir, branchName } = await ensureSessionWorktree(
      env,
      linearSessionId,
      issueId,
      linearClient,
      existingBranch,
    );

    // Get sandbox with session-specific workdir
    const { client } = await getOrInitializeSandbox(
      env,
      organizationId,
      workdir,
    );

    // Get or create OpenCode session for this Linear session
    const sessionResult = await getOrCreateSession(
      client,
      env.KV,
      linearSessionId,
      issueId,
      branchName,
    );
    const opencodeSessionId = sessionResult.opencodeSessionId;

    // Set externalLink on Linear session to link to OpenCode UI
    try {
      const externalLink = `${workerUrl}/opencode?session=${opencodeSessionId}`;
      const agentSession = await linearClient.agentSession(linearSessionId);
      await agentSession.update({ externalLink });
      console.info("Set externalLink on Linear session", { externalLink });
    } catch (error) {
      console.error("Failed to set externalLink", { error });
    }

    if (payload.action === "created") {
      console.info("New agent session created", { workdir, branchName });

      const prompt = payload.promptContext ?? "Please help with this issue.";

      console.info("Starting OpenCode prompt (async)", {
        sessionId: opencodeSessionId,
      });

      // Use promptAsync to return immediately - the sandbox Durable Object
      // continues running and the plugin streams events to Linear
      await client.session.promptAsync({
        path: { id: opencodeSessionId },
        body: {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
          parts: [{ type: "text", text: prompt }],
        },
      });

      console.info("OpenCode prompt started");
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
        payload.agentActivity?.content?.body ??
        payload.promptContext ??
        "Please continue.";

      // Use promptAsync to return immediately
      await client.session.promptAsync({
        path: { id: opencodeSessionId },
        body: {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
          parts: [{ type: "text", text: prompt }],
        },
      });

      console.info("OpenCode prompt started");
    }
  } catch (error) {
    console.error("Error processing webhook", { error });

    try {
      await linearClient.createAgentActivity({
        agentSessionId: linearSessionId,
        content: {
          type: "error",
          body: `Failed to process request: ${error instanceof Error ? error.message : String(error)}`,
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

  // Parse and verify the webhook payload using the SDK
  // parseData throws on invalid signature or timestamp
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
    console.info("Ignoring non-AgentSessionEvent", {
      type: webhookPayload.type,
    });
    return new Response("OK", { status: 200 });
  }

  const payload = webhookPayload;

  console.info("Webhook received, processing in background", {
    action: payload.action,
    sessionId: payload.agentSession.id,
  });

  // Extract worker URL for externalLink on Linear session
  const workerUrl = new URL(request.url).origin;

  // Process in background using waitUntil - Linear webhooks require response within 5s
  // The Durable Object (sandbox) keeps running after waitUntil completes,
  // so the plugin can stream events to Linear
  ctx.waitUntil(
    processAgentSessionEvent(payload, env, workerUrl).catch((error) => {
      console.error("Background processing failed", error);
    }),
  );

  return new Response("OK", { status: 200 });
}
