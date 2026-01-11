/**
 * Local server entry point for Linear OpenCode Agent
 *
 * This server runs in Docker and handles:
 * - Linear OAuth flow
 * - Linear webhooks (exposed publicly via Cloudflare Tunnel)
 * - Event processing (directly, no queue)
 *
 * Prerequisites:
 * - OpenCode running separately via `opencode serve`
 * - config.json with all required settings
 * - Local repository at the configured path
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { Result } from "better-result";
import {
  EventProcessor,
  handleAuthorize,
  handleCallback,
  handleWebhook,
  refreshAccessToken,
  LinearServiceImpl,
  OpencodeService,
  Log,
  type EventDispatcher,
  type KeyValueStore,
  type OAuthConfig,
  type TokenStore,
} from "@linear-opencode-agent/core";
import { loadConfig, getWorkerUrl, type Config } from "./config";
import { FileStore, FileTokenStore, FileSessionRepository } from "./storage";
import { RepoResolver } from "./RepoResolver";
import { join } from "node:path";

/**
 * Extract client IP from request headers
 * Cloudflare Tunnel sets CF-Connecting-IP header with the original client IP
 */
function getClientIp(request: Request): string | null {
  // Cloudflare sets CF-Connecting-IP with the original client IP
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) {
    return cfIp;
  }

  // Fallback to X-Forwarded-For (can contain multiple IPs: "client, proxy1, proxy2")
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
  const opencode = new OpencodeService(opencodeClient);

  const availableRepos = Object.keys(config.repos ?? {});

  return {
    async dispatch(event: AgentSessionEventWebhookPayload): Promise<void> {
      const organizationId = event.organizationId;
      const linearSessionId = event.agentSession.id;
      const issueId =
        event.agentSession.issue?.id ?? event.agentSession.issueId ?? "unknown";
      const issueIdentifier = event.agentSession.issue?.identifier ?? issueId;

      const log = Log.create({ service: "dispatcher" })
        .tag("organizationId", organizationId)
        .tag("issue", issueIdentifier);

      // Get or refresh access token
      let accessToken = await tokenStore.getAccessToken(organizationId);
      if (!accessToken) {
        log.info("No access token, attempting refresh");

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

      // Create Linear service (unified interface for all Linear operations)
      const linear = new LinearServiceImpl(accessToken);

      // Resolve which repository to use for this issue
      const repoResolver = RepoResolver.fromConfig(linear, config);
      const resolveResult = await repoResolver.resolve(issueId);

      // Handle resolution errors
      if (Result.isError(resolveResult)) {
        log.error("Failed to resolve repository", {
          error: resolveResult.error.message,
        });
        await linear.postError(linearSessionId, resolveResult.error);
        return;
      }

      const resolved = resolveResult.value;
      if (!resolved) {
        const errorMessage =
          `**Could not determine which repository to use for this issue.**\n\n` +
          `To fix this, add one of the following:\n` +
          `- A \`repo:*\` label (e.g., \`repo:linear-opencode-agent\`)\n` +
          `- A GitHub link in the issue description\n\n` +
          `Available repositories: ${availableRepos.join(", ")}`;

        await linear.postError(linearSessionId, new Error(errorMessage));
        log.error("Could not resolve repository", { availableRepos });
        return;
      }

      log.info("Resolved repository for issue", {
        issueId,
        repoKey: resolved.key,
        repoUrl: resolved.config.remoteUrl,
        localPath: resolved.config.localPath,
      });

      // Create event processor with repo directory
      // OpenCode handles worktree creation natively
      const processor = new EventProcessor(
        opencode,
        linear,
        sessionRepository,
        resolved.config.localPath,
        { opencodeUrl: config.opencode.url },
      );

      // Process the event directly (this is the key difference from Cloudflare)
      // Cloudflare uses a queue for 15min timeout, but locally we can just await
      // Note: processor.process() handles its own errors and posts them to Linear
      await processor.process(event);
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

      const log = Log.create({ service: "server" });

      // Helper to log and return response
      const respond = (response: Response): Response => {
        log.info("Request", {
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
          log.warn("Webhook request from unauthorized IP", {
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
 * Main entry point
 */
async function main(): Promise<ReturnType<typeof Bun.serve>> {
  const log = Log.create({ service: "startup" });
  log.info("Starting Linear OpenCode Agent (Local)");

  // Load configuration
  const config = await loadConfig();

  // Auto-discover repositories from filesystem
  const { discoverRepos } = await import("./RepoDiscovery");
  const discoveredRepos = await discoverRepos(config.paths.repos);

  // Merge discovered repos with explicitly configured repos (explicit config wins)
  const allRepos = { ...discoveredRepos, ...config.repos };

  // Update config with merged repos
  config.repos = allRepos;

  const configuredRepos = Object.keys(allRepos);
  log.info("Configuration loaded", {
    port: config.port,
    publicHostname: config.publicHostname,
    opencodeUrl: config.opencode.url,
    discoveredRepos: Object.keys(discoveredRepos).length,
    configuredRepos,
    defaultRepo: config.defaultRepo,
    worktreesPath: config.paths.workspace,
  });

  // Initialize storage
  // Use a single FileStore for all data, or separate stores for different concerns
  const dataPath = join(config.paths.data, "store.json");

  const kv = new FileStore(dataPath);
  const tokenStore = new FileTokenStore(kv);
  const sessionRepository = new FileSessionRepository(kv);

  log.info("Storage initialized", { dataPath });

  // Create event dispatcher (git operations created per-request based on issue)
  const dispatcher = createDirectDispatcher(
    config,
    tokenStore,
    sessionRepository,
  );

  // Start server
  const server = createServer(config, kv, tokenStore, dispatcher);

  const workerUrl = getWorkerUrl(config);
  log.info("Server started", {
    port: config.port,
    workerUrl,
    webhookUrl: `${workerUrl}/api/webhook/linear`,
    oauthUrl: `${workerUrl}/api/oauth/authorize`,
  });

  // Banner output - use process.stdout directly for multi-line
  process.stdout.write(`
Linear OpenCode Agent (Local) running!

  Local:    http://localhost:${config.port}
  Public:   ${workerUrl}

  Webhook URL: ${workerUrl}/api/webhook/linear
  OAuth URL:   ${workerUrl}/api/oauth/authorize

Make sure OpenCode is running: opencode serve
`);

  return server;
}

// Run the server
main().catch((error) => {
  const log = Log.create({ service: "startup" });
  log.error("Failed to start server", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
