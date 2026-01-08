/**
 * Agent Worker - queue consumer for processing Linear events + OpenCode UI proxy
 *
 * This worker:
 * - Consumes events from the queue and processes them via EventProcessor
 * - Proxies requests to the Sandbox's OpenCode UI for viewing agent work
 * - Handles WebSocket connections for real-time updates
 *
 * Queue provides:
 * - 15 minute execution limit (vs 30s for waitUntil)
 * - Automatic retries on failure
 * - Better error isolation
 */

import { EventProcessor } from "@linear-opencode-agent/core";
import type { LinearEventMessage } from "@linear-opencode-agent/core";
import {
  Sandbox,
  KVStore,
  KVSessionRepository,
  KVTokenStore,
  CloudflareSandbox,
  SandboxGitOperations,
  LinearClientAdapter,
  getSandbox,
  createOpencode,
  proxyToOpencode,
} from "@linear-opencode-agent/infrastructure";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { refreshAccessToken } from "./oauth";
import { getConfig } from "./config";
import { validateAuth, unauthorizedResponse, createAuthCookie } from "./auth";

// Re-export Sandbox for wrangler Durable Object binding
export { Sandbox };

// Constants
const SANDBOX_ID = "opencode-instance";
const OPENCODE_PORT = 4096;
const PROJECT_DIR = "/workspace";

// MIME type mapping for static assets
const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".html": "text/html",
  ".txt": "text/plain",
};

/**
 * Fix missing/incorrect Content-Type headers
 */
function fixContentType(response: Response, pathname: string): Response {
  const contentType = response.headers.get("Content-Type");

  if (contentType && contentType !== "application/octet-stream") {
    return response;
  }

  const ext = pathname.match(/(\.[^.]+)$/)?.[1];
  const mimeType = ext ? MIME_TYPES[ext] : null;

  if (!mimeType) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", mimeType);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle HTTP requests (OpenCode UI proxy)
 */
async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  console.info({
    message: "HTTP request",
    stage: "proxy",
    method: request.method,
    pathname: url.pathname,
  });

  // Health check endpoint
  if (url.pathname === "/health") {
    return new Response("OK", { status: 200 });
  }

  // Check if request has Basic Auth header (for cookie setting)
  const hasBasicAuthHeader = request.headers
    .get("Authorization")
    ?.startsWith("Basic ");

  // Validate authentication
  if (!(await validateAuth(request, env.ADMIN_API_KEY))) {
    return unauthorizedResponse();
  }

  // Get sandbox instance
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

  // Ensure sandbox is running
  await sandbox.start();

  // Create OpenCode server if needed
  const { server } = await createOpencode<OpencodeClient>(sandbox, {
    port: OPENCODE_PORT,
    directory: PROJECT_DIR,
    config: getConfig(env).config,
  });

  // Handle WebSocket upgrade
  const isWebSocketUpgrade =
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    request.headers.get("Connection")?.toLowerCase().includes("upgrade");

  if (isWebSocketUpgrade) {
    return sandbox.wsConnect(request, server.port);
  }

  // Proxy to OpenCode
  const response = await proxyToOpencode(request, sandbox, server);

  // Fix Content-Type headers
  const fixedResponse = fixContentType(response, url.pathname);

  // Set auth cookie if authenticated via Basic Auth
  if (hasBasicAuthHeader && env.ADMIN_API_KEY) {
    const headers = new Headers(fixedResponse.headers);
    headers.append("Set-Cookie", await createAuthCookie(env.ADMIN_API_KEY));

    return new Response(fixedResponse.body, {
      status: fixedResponse.status,
      statusText: fixedResponse.statusText,
      headers,
    });
  }

  return fixedResponse;
}

/**
 * Process a single queue message
 */
async function processMessage(
  message: LinearEventMessage,
  env: Env,
): Promise<void> {
  const { payload, workerUrl } = message;
  const linearSessionId = payload.agentSession.id;
  const organizationId = payload.organizationId;
  const issueId =
    payload.agentSession.issue?.id ?? payload.agentSession.issueId ?? "unknown";

  if (!organizationId) {
    console.error({
      message: "No organization ID in webhook payload",
      stage: "agent",
      linearSessionId,
      issueId,
    });
    return;
  }

  console.info({
    message: "Processing started",
    stage: "agent",
    action: payload.action,
    linearSessionId,
    issueId,
    organizationId,
  });

  // Create infrastructure instances
  const kv = new KVStore(env.KV);
  const sessionRepository = new KVSessionRepository(kv);
  const tokenStore = new KVTokenStore(kv);

  // Get access token (refresh if needed)
  let accessToken = await tokenStore.getAccessToken(organizationId);
  if (!accessToken) {
    console.info({
      message: "Access token not found, refreshing",
      stage: "agent",
      linearSessionId,
      organizationId,
    });
    accessToken = await refreshAccessToken(env, tokenStore, organizationId);
  }

  // Create Linear adapter for error reporting FIRST
  const linearAdapter = new LinearClientAdapter(accessToken);

  // Post processing started activity
  await linearAdapter.postStageActivity(linearSessionId, "processing_started");

  try {
    // Post sandbox initializing activity
    await linearAdapter.postStageActivity(
      linearSessionId,
      "sandbox_initializing",
    );

    console.info({
      message: "Initializing sandbox",
      stage: "agent",
      linearSessionId,
      organizationId,
    });

    // Create sandbox provider
    const sandboxProvider = new CloudflareSandbox(env.Sandbox, {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      LINEAR_ACCESS_TOKEN: accessToken,
    });

    // Get session workdir from existing state or compute new one
    const existingState = await sessionRepository.get(linearSessionId);
    const workdir =
      existingState?.workdir ?? `/workspace/sessions/${linearSessionId}`;

    // Initialize sandbox and get OpenCode client
    const { client } = await sandboxProvider.getOpencodeClient(
      organizationId,
      workdir,
      getConfig(env),
    );

    console.info({
      message: "Sandbox initialized",
      stage: "agent",
      linearSessionId,
      workdir,
    });

    // Create git operations
    const gitOperations = new SandboxGitOperations(
      sandboxProvider,
      organizationId,
      env.REPO_URL,
      env.GITHUB_TOKEN,
    );

    // Create event processor and process the event
    const processor = new EventProcessor(
      client,
      linearAdapter,
      sessionRepository,
      gitOperations,
    );

    await processor.process(payload, workerUrl);

    console.info({
      message: "Event processed successfully",
      stage: "agent",
      action: payload.action,
      linearSessionId,
      issueId,
      organizationId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error({
      message: "Error processing event",
      stage: "agent",
      error: errorMessage,
      stack: errorStack,
      linearSessionId,
      issueId,
      organizationId,
    });

    // Report error to Linear with full details
    await linearAdapter.postError(linearSessionId, error);

    // Re-throw for queue retry
    throw error;
  }
}

export default {
  /**
   * HTTP handler - proxies to OpenCode UI
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },

  /**
   * Queue handler - processes batches of messages
   */
  async queue(
    batch: MessageBatch<LinearEventMessage>,
    env: Env,
  ): Promise<void> {
    console.info({
      message: "Processing batch",
      stage: "queue",
      batchSize: batch.messages.length,
    });

    // Process messages sequentially - each message must complete before the next
    for (const message of batch.messages) {
      const linearSessionId = message.body.payload.agentSession.id;
      try {
        await processMessage(message.body, env);
        message.ack();
        console.info({
          message: "Message acknowledged",
          stage: "queue",
          linearSessionId,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error({
          message: "Message processing failed, will retry",
          stage: "queue",
          error: errorMessage,
          linearSessionId,
        });
        // Don't ack - will be retried
        message.retry();
      }
    }
  },
};
