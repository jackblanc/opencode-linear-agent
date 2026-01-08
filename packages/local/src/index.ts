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
import { LinearClient } from "@linear/sdk";
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
import {
  loadConfig,
  getWorkerUrl,
  type Config,
  type RepoConfig,
} from "./config";
import { FileStore, FileTokenStore, FileSessionRepository } from "./storage";
import { LocalGitOperations } from "./git";
import { RepoResolver } from "./RepoResolver";
import { join } from "node:path";

/**
 * Extract client IP from request headers
 * Tailscale Funnel sets X-Forwarded-For header
 */
function getClientIp(request: Request): string | null {
  // X-Forwarded-For can contain multiple IPs: "client, proxy1, proxy2"
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const firstIp = xff.split(",")[0].trim();
    return firstIp || null;
  }
  return null;
}

/**
 * Check if an IP is in the allowlist
 */
function isAllowedIp(ip: string | null, allowlist: string[]): boolean {
  if (!ip) {
    return false;
  }
  return allowlist.includes(ip);
}

/**
 * Create GitOperations for a specific repo
 */
function createGitOperations(
  repoConfig: RepoConfig,
  worktreesPath: string,
  githubToken: string,
): LocalGitOperations {
  return new LocalGitOperations(
    repoConfig.localPath,
    worktreesPath,
    githubToken,
    repoConfig.remoteUrl,
  );
}

/**
 * Create a direct event dispatcher that processes events immediately
 * (no queue, unlike Cloudflare)
 */
function createDirectDispatcher(
  config: Config,
  tokenStore: TokenStore,
  sessionRepository: FileSessionRepository,
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
      const issueId =
        event.agentSession.issue?.id ?? event.agentSession.issueId ?? "unknown";

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

      // Create Linear client for repo resolution
      const linearClient = new LinearClient({ accessToken });

      // Resolve which repository to use for this issue
      const repoResolver = RepoResolver.fromConfig(linearClient, config);
      const resolved = await repoResolver.resolve(issueId);

      if (!resolved) {
        throw new Error(
          `Could not resolve repository for issue ${issueId}. ` +
            `Add a GitHub link to the issue or configure a default repo.`,
        );
      }

      console.info({
        message: "Resolved repository for issue",
        stage: "dispatcher",
        issueId,
        repoKey: resolved.key,
        repoUrl: resolved.config.remoteUrl,
      });

      // Create GitOperations for the resolved repo
      const gitOperations = createGitOperations(
        resolved.config,
        config.paths.worktrees,
        config.github.token,
      );

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

      const clientIp = getClientIp(request);

      // Helper to log and return response
      const respond = (response: Response): Response => {
        console.info({
          message: "Request",
          stage: "server",
          method: request.method,
          pathname,
          status: response.status,
          clientIp,
        });
        return response;
      };

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
        // IP allowlist check - only Linear's servers can call this endpoint
        if (!isAllowedIp(clientIp, config.linear.webhookIps)) {
          console.warn({
            message: "Webhook request from unauthorized IP",
            stage: "server",
            clientIp,
            allowedIps: config.linear.webhookIps,
          });
          return respond(new Response("Forbidden", { status: 403 }));
        }

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

      return respond(new Response("Not found", { status: 404 }));
    },
  });
}

/**
 * Get list of configured repos for logging
 */
function getConfiguredRepos(config: Config): string[] {
  if (config.repos) {
    return Object.keys(config.repos);
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional backward compat
  if (config.repo) {
    return ["default (single repo)"];
  }
  return [];
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

  const configuredRepos = getConfiguredRepos(config);
  console.info({
    message: "Configuration loaded",
    stage: "startup",
    port: config.port,
    tailscaleHostname: config.tailscaleHostname,
    opencodeUrl: config.opencode.url,
    configuredRepos,
    defaultRepo: config.defaultRepo,
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

  // Create event dispatcher (git operations created per-request based on issue)
  const dispatcher = createDirectDispatcher(
    config,
    tokenStore,
    sessionRepository,
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
