import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  AgentSessionEventWebhookPayload,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import { LinearClient } from "@linear/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  getOrInitializeSandbox,
  getSandboxInstance,
  REPO_DIR,
  getSessionWorkdir,
} from "./sandbox";

// Prefix used in OpenCode session titles to identify Linear sessions
const LINEAR_SESSION_PREFIX = "linear:";

/**
 * Result of sandbox.exec command
 */
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command in the sandbox with comprehensive logging.
 * Logs the command, timing, and result. Throws on non-zero exit code.
 */
async function execWithLogging(
  sandbox: Sandbox,
  command: string,
  options: { timeout: number },
  context: string,
): Promise<ExecResult> {
  const startTime = Date.now();
  console.info(`[${context}] Executing command: ${command}`);

  let result: ExecResult;
  try {
    result = await sandbox.exec(command, options);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[${context}] Command threw exception after ${elapsed}ms: ${errorMessage}`,
    );
    throw error;
  }

  const elapsed = Date.now() - startTime;

  if (result.exitCode !== 0) {
    console.error(
      `[${context}] Command failed after ${elapsed}ms with exit code ${result.exitCode}`,
    );
    if (result.stderr) {
      console.error(`[${context}] stderr: ${result.stderr}`);
    }
    if (result.stdout) {
      console.info(`[${context}] stdout: ${result.stdout}`);
    }
    throw new Error(
      `Command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
    );
  }

  console.info(`[${context}] Command succeeded in ${elapsed}ms`);
  return result;
}

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
  console.info(
    `[session] Looking up existing session state for ${linearSessionId}`,
  );
  const existingState = await kv.get<SessionState>(stateKey, "json");

  if (existingState?.opencodeSessionId) {
    console.info(
      `[session] Found existing state, attempting to resume OpenCode session ${existingState.opencodeSessionId}`,
    );

    try {
      const session = await client.session.get({
        path: { id: existingState.opencodeSessionId },
      });

      if (session.data) {
        console.info(
          `[session] Successfully resumed session ${session.data.id}`,
        );
        return { opencodeSessionId: session.data.id, existingState };
      }
      console.warn(
        `[session] Session ${existingState.opencodeSessionId} not found, creating new one`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[session] Failed to resume session: ${errorMessage}, creating new one`,
      );
    }
  }

  console.info(
    `[session] Creating new OpenCode session for Linear session ${linearSessionId}`,
  );
  const session = await client.session.create({
    body: {
      title: `${LINEAR_SESSION_PREFIX}${linearSessionId}`,
    },
  });

  if (!session.data) {
    console.error(
      "[session] OpenCode API returned no data when creating session",
    );
    throw new Error("Failed to create OpenCode session");
  }

  console.info(`[session] Created OpenCode session ${session.data.id}`);

  const newState: SessionState = {
    opencodeSessionId: session.data.id,
    linearSessionId,
    issueId,
    branchName,
    lastActivityTime: Date.now(),
  };

  await kv.put(stateKey, JSON.stringify(newState));
  console.info(`[session] Saved session state to KV`);

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

  console.info(`[clone] Step 1/3: Checking if main repo exists at ${REPO_DIR}`);
  const repoExists = await sandbox.exists(`${REPO_DIR}/.git`);
  if (repoExists.exists) {
    console.info(`[clone] Main repository already cloned at ${REPO_DIR}`);
    return;
  }

  console.info(`[clone] Step 2/3: Validating environment variables`);
  if (!env.REPO_URL) {
    console.error("[clone] REPO_URL environment variable is not configured");
    throw new Error("REPO_URL environment variable is not configured");
  }
  if (!env.GITHUB_TOKEN) {
    console.error(
      "[clone] GITHUB_TOKEN environment variable is not configured",
    );
    throw new Error("GITHUB_TOKEN environment variable is not configured");
  }
  console.info(
    `[clone] Environment variables validated, REPO_URL: ${env.REPO_URL}`,
  );

  await linearClient.createAgentActivity({
    agentSessionId: linearSessionId,
    content: {
      type: "thought",
      body: "Cloning repository...",
    },
    ephemeral: true,
  });

  console.info(`[clone] Step 3/3: Cloning repository to ${REPO_DIR}`);
  const authedRepoUrl = env.REPO_URL.replace(
    "https://github.com/",
    `https://${env.GITHUB_TOKEN}@github.com/`,
  );

  await execWithLogging(
    sandbox,
    `mkdir -p ${REPO_DIR}`,
    { timeout: 30000 },
    "clone-mkdir",
  );

  await execWithLogging(
    sandbox,
    `git clone ${authedRepoUrl} ${REPO_DIR}`,
    { timeout: 120000 },
    "clone-git",
  );

  console.info(`[clone] Main repository cloned successfully to ${REPO_DIR}`);
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

  console.info(
    `[worktree] Starting worktree setup for session ${linearSessionId}, workdir: ${workdir}, branch: ${branchName}`,
  );

  // Step 1: Ensure main repo is cloned
  console.info(`[worktree] Step 1/7: Ensuring main repo is cloned`);
  await ensureMainRepoCloned(env, linearSessionId, linearClient);

  // Step 2: Check if worktree already exists
  console.info(
    `[worktree] Step 2/7: Checking if worktree already exists at ${workdir}`,
  );
  const worktreeExists = await sandbox.exists(`${workdir}/.git`);
  if (worktreeExists.exists) {
    console.info(
      `[worktree] Worktree already exists at ${workdir}, skipping setup`,
    );
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

  // Step 3: Create sessions directory
  console.info(`[worktree] Step 3/7: Creating sessions directory`);
  await execWithLogging(
    sandbox,
    "mkdir -p /workspace/sessions",
    { timeout: 30000 },
    "worktree-mkdir",
  );

  // Step 4: Check if branch already exists on remote (for resume)
  console.info(
    `[worktree] Step 4/7: Checking if branch ${branchName} exists on remote`,
  );
  const branchExistsResult = await sandbox.exec(
    `cd ${REPO_DIR} && git fetch origin ${branchName} 2>/dev/null && echo "exists" || echo "new"`,
    { timeout: 60000 },
  );
  const branchExists = branchExistsResult.stdout.trim() === "exists";
  console.info(
    `[worktree] Branch ${branchName} exists on remote: ${branchExists}`,
  );

  // Step 5: Create worktree
  console.info(`[worktree] Step 5/7: Creating worktree`);
  if (branchExists) {
    console.info(
      `[worktree] Resuming from existing remote branch: ${branchName}`,
    );
    await execWithLogging(
      sandbox,
      `cd ${REPO_DIR} && git worktree add ${workdir} origin/${branchName}`,
      { timeout: 60000 },
      "worktree-add-existing",
    );
  } else {
    console.info(`[worktree] Creating new branch: ${branchName}`);
    await execWithLogging(
      sandbox,
      `cd ${REPO_DIR} && git worktree add -b ${branchName} ${workdir}`,
      { timeout: 60000 },
      "worktree-add-new",
    );
  }

  // Step 6: Configure git user and remote
  console.info(`[worktree] Step 6/7: Configuring git user and remote`);
  await execWithLogging(
    sandbox,
    `cd ${workdir} && git config user.name "Linear OpenCode Agent" && git config user.email "agent@linear.app"`,
    { timeout: 30000 },
    "worktree-git-config",
  );

  if (env.GITHUB_TOKEN && env.REPO_URL) {
    const authedRepoUrl = env.REPO_URL.replace(
      "https://github.com/",
      `https://${env.GITHUB_TOKEN}@github.com/`,
    );
    await execWithLogging(
      sandbox,
      `cd ${workdir} && git remote set-url origin ${authedRepoUrl}`,
      { timeout: 30000 },
      "worktree-remote-url",
    );
  }

  // Step 7: Install dependencies
  console.info(`[worktree] Step 7/7: Installing dependencies`);
  await linearClient.createAgentActivity({
    agentSessionId: linearSessionId,
    content: {
      type: "thought",
      body: "Installing dependencies...",
    },
    ephemeral: true,
  });

  await execWithLogging(
    sandbox,
    `cd ${workdir} && bun install`,
    { timeout: 120000 },
    "worktree-bun-install",
  );

  console.info(
    `[worktree] Session worktree created successfully at ${workdir} on branch ${branchName}`,
  );
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
  const linearSessionId = payload.agentSession.id;
  console.info(
    `[webhook] Processing ${payload.action} event for session ${linearSessionId}`,
  );

  const organizationId = payload.organizationId;
  if (!organizationId) {
    console.error("[webhook] No organization ID in webhook payload");
    return;
  }
  console.info(`[webhook] Organization ID: ${organizationId}`);

  // Create Linear client for sending activities
  console.info(
    `[webhook] Fetching access token for organization ${organizationId}`,
  );
  const accessToken = await env.KV.get(`token:access:${organizationId}`);
  if (!accessToken) {
    console.error(
      `[webhook] No access token available for organization ${organizationId}`,
    );
    return;
  }
  console.info(`[webhook] Access token retrieved successfully`);

  const linearClient = new LinearClient({ accessToken });

  // Extract issue ID from payload
  const issueId =
    payload.agentSession.issue?.id ?? payload.agentSession.issueId ?? "unknown";
  console.info(`[webhook] Issue ID: ${issueId}`);

  // Send immediate acknowledgment to Linear
  try {
    console.info(`[webhook] Sending acknowledgment to Linear`);
    await linearClient.createAgentActivity({
      agentSessionId: linearSessionId,
      content: {
        type: "thought",
        body: "Starting to work on this...",
      },
      ephemeral: true,
    });
    console.info(`[webhook] Acknowledgment sent successfully`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[webhook] Failed to send acknowledgment: ${errorMessage}`);
  }

  try {
    // Set up the session worktree (handles both new and resumed sessions)
    console.info(`[webhook] Checking for existing session state`);
    const stateKey = `session:${linearSessionId}`;
    const existingState = await env.KV.get<SessionState>(stateKey, "json");
    const existingBranch = existingState?.branchName;
    console.info(
      `[webhook] Existing state: ${existingState ? `found (branch: ${existingBranch})` : "not found"}`,
    );

    console.info(`[webhook] Setting up session worktree`);
    const { workdir, branchName } = await ensureSessionWorktree(
      env,
      linearSessionId,
      issueId,
      linearClient,
      existingBranch,
    );
    console.info(
      `[webhook] Worktree ready at ${workdir} on branch ${branchName}`,
    );

    // Get sandbox with session-specific workdir
    console.info(`[webhook] Initializing sandbox with workdir ${workdir}`);
    const { client } = await getOrInitializeSandbox(
      env,
      organizationId,
      workdir,
    );
    console.info(`[webhook] Sandbox initialized`);

    // Get or create OpenCode session for this Linear session
    console.info(`[webhook] Getting or creating OpenCode session`);
    const sessionResult = await getOrCreateSession(
      client,
      env.KV,
      linearSessionId,
      issueId,
      branchName,
    );
    const opencodeSessionId = sessionResult.opencodeSessionId;
    console.info(`[webhook] OpenCode session ID: ${opencodeSessionId}`);

    // Set externalLink on Linear session to link to OpenCode UI
    try {
      const externalLink = `${workerUrl}/opencode?session=${opencodeSessionId}`;
      console.info(
        `[webhook] Setting externalLink on Linear session: ${externalLink}`,
      );
      const agentSession = await linearClient.agentSession(linearSessionId);
      await agentSession.update({ externalLink });
      console.info(`[webhook] externalLink set successfully`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[webhook] Failed to set externalLink: ${errorMessage}`);
    }

    if (payload.action === "created") {
      console.info(
        `[webhook] New agent session created at ${workdir} on branch ${branchName}`,
      );

      const prompt = payload.promptContext ?? "Please help with this issue.";
      console.info(
        `[webhook] Starting OpenCode prompt (${prompt.length} chars) for session ${opencodeSessionId}`,
      );

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

      console.info(`[webhook] OpenCode prompt started successfully`);
    } else if (payload.action === "prompted") {
      console.info(`[webhook] Agent prompted with follow-up`);

      // Check for stop signal
      if (payload.agentActivity && hasStopSignal(payload.agentActivity)) {
        console.info(
          `[webhook] Stop signal received, aborting session ${opencodeSessionId}`,
        );

        try {
          await client.session.abort({ path: { id: opencodeSessionId } });
          console.info(`[webhook] Session aborted successfully`);

          await linearClient.createAgentActivity({
            agentSessionId: linearSessionId,
            content: {
              type: "response",
              body: "Work stopped as requested.",
            },
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(`[webhook] Failed to abort session: ${errorMessage}`);
        }
        return;
      }

      const prompt =
        payload.agentActivity?.content?.body ??
        payload.promptContext ??
        "Please continue.";
      console.info(
        `[webhook] Sending follow-up prompt (${prompt.length} chars) to session ${opencodeSessionId}`,
      );

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

      console.info(`[webhook] OpenCode prompt started successfully`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`[webhook] Error processing webhook: ${errorMessage}`);
    if (errorStack) {
      console.error(`[webhook] Stack trace: ${errorStack}`);
    }

    try {
      await linearClient.createAgentActivity({
        agentSessionId: linearSessionId,
        content: {
          type: "error",
          body: `Failed to process request: ${errorMessage}`,
        },
      });
      console.info(`[webhook] Error activity sent to Linear`);
    } catch (activityError) {
      const activityErrorMessage =
        activityError instanceof Error
          ? activityError.message
          : String(activityError);
      console.error(
        `[webhook] Failed to send error activity: ${activityErrorMessage}`,
      );
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
    console.info(
      `[webhook] Ignoring non-AgentSessionEvent: ${webhookPayload.type}`,
    );
    return new Response("OK", { status: 200 });
  }

  const payload = webhookPayload;

  console.info(
    `[webhook] Received ${payload.action} webhook for session ${payload.agentSession.id}, processing in background`,
  );

  // Extract worker URL for externalLink on Linear session
  const workerUrl = new URL(request.url).origin;

  // Process in background using waitUntil - Linear webhooks require response within 5s
  // The Durable Object (sandbox) keeps running after waitUntil completes,
  // so the plugin can stream events to Linear
  ctx.waitUntil(
    processAgentSessionEvent(payload, env, workerUrl).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`[webhook] Background processing failed: ${errorMessage}`);
      if (errorStack) {
        console.error(`[webhook] Stack trace: ${errorStack}`);
      }
    }),
  );

  return new Response("OK", { status: 200 });
}
