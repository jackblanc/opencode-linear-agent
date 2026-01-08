/**
 * Local server entry point for Linear OpenCode Agent
 *
 * This server runs on your local machine (accessible via Tailscale) and handles:
 * - Linear OAuth flow
 * - Linear webhooks
 * - Event processing (directly, no queue)
 *
 * Prerequisites:
 * - OpenCode running separately via `opencode serve`
 * - config.json with all required settings
 * - Local repository at the configured path
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import {
  EventProcessor,
  handleAuthorize,
  handleCallback,
  handleWebhook,
  refreshAccessToken,
  LinearClientAdapter,
  type EventDispatcher,
  type KeyValueStore,
  type OAuthConfig,
  type TokenStore,
} from "@linear-opencode-agent/core";
import { loadConfig, getWorkerUrl, type Config } from "./config";
import { FileStore, FileTokenStore, FileSessionRepository } from "./storage";
import { LocalGitOperations } from "./git";
import { join } from "node:path";

/**
 * Create a direct event dispatcher that processes events immediately
 * (no queue, unlike Cloudflare)
 */
function createDirectDispatcher(
  config: Config,
  tokenStore: TokenStore,
  sessionRepository: FileSessionRepository,
  gitOperations: LocalGitOperations,
): EventDispatcher {
  const opencodeClient = createOpencodeClient({
    baseUrl: config.opencode.url,
  });

  return {
    async dispatch(
      event: AgentSessionEventWebhookPayload,
      workerUrl: string,
    ): Promise<void> {
      const organizationId = event.organizationId;

      // Get or refresh access token
      let accessToken = await tokenStore.getAccessToken(organizationId);
      if (!accessToken) {
        console.info({
          message: "No access token, attempting refresh",
          stage: "dispatcher",
          organizationId,
        });

        const oauthConfig: OAuthConfig = {
          clientId: config.linear.clientId,
          clientSecret: config.linear.clientSecret,
        };

        accessToken = await refreshAccessToken(
          oauthConfig,
          tokenStore,
          organizationId,
        );
      }

      // Create Linear adapter
      const linearAdapter = new LinearClientAdapter(accessToken);

      // Create event processor
      const processor = new EventProcessor(
        opencodeClient,
        linearAdapter,
        sessionRepository,
        gitOperations,
      );

      // Process the event directly (this is the key difference from Cloudflare)
      // Cloudflare uses a queue for 15min timeout, but locally we can just await
      await processor.process(event, workerUrl);
    },
  };
}

/**
 * Create the HTTP server
 */
function createServer(
  config: Config,
  kv: KeyValueStore,
  tokenStore: TokenStore,
  dispatcher: EventDispatcher,
): ReturnType<typeof Bun.serve> {
  const oauthConfig: OAuthConfig = {
    clientId: config.linear.clientId,
    clientSecret: config.linear.clientSecret,
    baseUrl: getWorkerUrl(config),
  };

  return Bun.serve({
    port: config.port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Helper to log and return response
      const respond = (response: Response): Response => {
        console.info({
          message: "Request",
          stage: "server",
          method: request.method,
          pathname,
          status: response.status,
        });
        return response;
      };

      // Health check
      if (pathname === "/health") {
        return respond(
          Response.json({
            status: "ok",
            timestamp: new Date().toISOString(),
          }),
        );
      }

      // OAuth authorize - start the OAuth flow
      if (pathname === "/api/oauth/authorize") {
        return respond(await handleAuthorize(request, oauthConfig, kv));
      }

      // OAuth callback - handle the redirect from Linear
      if (pathname === "/api/oauth/callback") {
        return respond(
          await handleCallback(request, oauthConfig, kv, tokenStore),
        );
      }

      // Linear webhook (support both paths for consistency with Cloudflare worker)
      if (
        pathname === "/api/webhook/linear" ||
        pathname === "/webhook/linear"
      ) {
        return respond(
          await handleWebhook(
            request,
            config.linear.webhookSecret,
            tokenStore,
            dispatcher,
            undefined, // statusPosterFactory
            config.linear.organizationId, // only accept webhooks from this org
          ),
        );
      }

      // Info page
      if (pathname === "/") {
        const workerUrl = getWorkerUrl(config);
        return respond(
          new Response(
            `Linear OpenCode Agent (Local)

Endpoints:
  GET  /health               - Health check
  GET  /api/oauth/authorize  - Start Linear OAuth flow
  GET  /api/oauth/callback   - OAuth callback (used by Linear)
  POST /api/webhook/linear   - Linear webhook endpoint

Webhook URL for Linear:
  ${workerUrl}/api/webhook/linear

OAuth Start URL:
  ${workerUrl}/api/oauth/authorize
`,
            {
              status: 200,
              headers: { "Content-Type": "text/plain" },
            },
          ),
        );
      }

      return respond(new Response("Not found", { status: 404 }));
    },
  });
}

/**
 * Main entry point
 */
async function main(): Promise<ReturnType<typeof Bun.serve>> {
  console.info({
    message: "Starting Linear OpenCode Agent (Local)",
    stage: "startup",
  });

  // Load configuration
  const config = await loadConfig();

  console.info({
    message: "Configuration loaded",
    stage: "startup",
    port: config.port,
    tailscaleHostname: config.tailscaleHostname,
    opencodeUrl: config.opencode.url,
    repoPath: config.repo.localPath,
    worktreesPath: config.paths.worktrees,
  });

  // Initialize storage
  // Use a single FileStore for all data, or separate stores for different concerns
  const dataPath = join(config.paths.data, "store.json");

  const kv = new FileStore(dataPath);
  const tokenStore = new FileTokenStore(kv);
  const sessionRepository = new FileSessionRepository(kv);

  console.info({
    message: "Storage initialized",
    stage: "startup",
    dataPath,
  });

  // Initialize git operations
  const gitOperations = new LocalGitOperations(
    config.repo.localPath,
    config.paths.worktrees,
    config.github.token,
    config.repo.remoteUrl,
  );

  console.info({
    message: "Git operations initialized",
    stage: "startup",
    repoPath: config.repo.localPath,
    worktreesPath: config.paths.worktrees,
  });

  // Create event dispatcher
  const dispatcher = createDirectDispatcher(
    config,
    tokenStore,
    sessionRepository,
    gitOperations,
  );

  // Start server
  const server = createServer(config, kv, tokenStore, dispatcher);

  const workerUrl = getWorkerUrl(config);
  console.info({
    message: "Server started",
    stage: "startup",
    port: config.port,
    workerUrl,
    webhookUrl: `${workerUrl}/api/webhook/linear`,
    oauthUrl: `${workerUrl}/api/oauth/authorize`,
  });

  console.log(`
Linear OpenCode Agent (Local) running!

  Local:    http://localhost:${config.port}
  Tailscale: ${workerUrl}

  Webhook URL: ${workerUrl}/api/webhook/linear
  OAuth URL:   ${workerUrl}/api/oauth/authorize

Make sure OpenCode is running: opencode serve
`);

  return server;
}

// Run the server
main().catch((error) => {
  console.error({
    message: "Failed to start server",
    stage: "startup",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
