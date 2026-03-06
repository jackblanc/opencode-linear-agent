/**
 * Local server entry point for Linear OpenCode Agent
 *
 * Handles:
 * - Linear OAuth flow
 * - Linear webhooks (exposed publicly via Cloudflare Tunnel)
 * - Event processing (directly, no queue)
 *
 * Prerequisites:
 * - OpenCode running separately via `opencode serve`
 * - Environment variables configured (see .env.example)
 * - Local repository at the configured path
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
} from "@linear/sdk/webhooks";
import { Result } from "better-result";
import {
  IssueEventHandler,
  WorktreeManager,
  handleAuthorize,
  handleCallback,
  handleWebhook,
  refreshAccessToken,
  LinearServiceImpl,
  OpencodeService,
  Log,
  parseStoreData,
  type EventDispatcher,
  type KeyValueStore,
  type OAuthConfig,
  type TokenStore,
} from "@opencode-linear-agent/core";
import { loadConfig, getWorkerUrl, getDataDir, type Config } from "./config";
import { FileStore, FileTokenStore, FileSessionRepository } from "./storage";
import { dispatchAgentSessionEvent } from "./AgentSessionDispatcher";
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
    const firstIp = xff.split(",")[0]?.trim();
    return firstIp ?? null;
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

  return {
    async dispatch(
      event:
        | AgentSessionEventWebhookPayload
        | EntityWebhookPayloadWithIssueData,
    ): Promise<void> {
      const organizationId = event.organizationId;

      if (event.type === "Issue") {
        // Get or refresh access token
        let accessToken = await tokenStore.getAccessToken(organizationId);
        if (!accessToken) {
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

        const linear = new LinearServiceImpl(accessToken);
        const worktreeManager = new WorktreeManager(
          opencode,
          linear,
          sessionRepository,
          config.projectsPath,
        );

        const issueHandler = new IssueEventHandler(
          linear,
          opencode,
          sessionRepository,
          worktreeManager,
        );
        await issueHandler.process(event);
        return;
      }

      // Get or refresh access token
      let accessToken = await tokenStore.getAccessToken(organizationId);
      if (!accessToken) {
        Log.create({ service: "dispatcher" })
          .tag("organizationId", organizationId)
          .info("No access token, attempting refresh");

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

      await dispatchAgentSessionEvent(
        event,
        linear,
        opencode,
        sessionRepository,
        {
          organizationId,
          projectsPath: config.projectsPath,
        },
      );
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

      if (pathname === "/health") {
        return respond(new Response("OK", { status: 200 }));
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
 * Proactively refresh the access token on a timer so the plugin
 * always has a valid token in the shared store.
 * Token TTL is 23 hours; we refresh every 20 hours for a 3-hour buffer.
 */
function startTokenRefreshTimer(config: Config, tokenStore: TokenStore): void {
  const log = Log.create({ service: "token-refresh" });
  const organizationId = config.linear.organizationId;
  if (!organizationId) {
    log.info(
      "Skipping proactive token refresh (LINEAR_ORGANIZATION_ID not set)",
    );
    return;
  }
  const oauthConfig: OAuthConfig = {
    clientId: config.linear.clientId,
    clientSecret: config.linear.clientSecret,
  };

  const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

  const refresh = async (): Promise<void> => {
    try {
      await refreshAccessToken(oauthConfig, tokenStore, organizationId);
      log.info("Proactive token refresh succeeded");
    } catch (error) {
      log.error("Proactive token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void refresh();
  setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
}

async function validateStoreFile(
  filePath: string,
  log: ReturnType<typeof Log.create>,
): Promise<void> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return;
  }

  const result = await Result.tryPromise({
    try: async () => {
      const json: unknown = await file.json();
      parseStoreData(json);
    },
    catch: (e) => (e instanceof Error ? e.message : String(e)),
  });

  if (Result.isError(result)) {
    log.warn("Invalid shared store file detected", {
      dataPath: filePath,
      error: result.error,
      recovery:
        "Fix/restore store.json, restart server, then re-auth Linear if token data was lost.",
    });
  }
}

/**
 * Main entry point
 */
async function main(): Promise<ReturnType<typeof Bun.serve>> {
  const log = Log.create({ service: "startup" });
  log.info("Starting Linear OpenCode Agent (Local)");

  // Load configuration
  const config = loadConfig();

  log.info("Configuration loaded", {
    port: config.port,
    publicHostname: config.publicHostname,
    opencodeUrl: config.opencode.url,
    projectsPath: config.projectsPath,
  });

  // Initialize storage
  const dataDir = getDataDir();
  const dataPath = join(dataDir, "store.json");

  const kv = new FileStore(dataPath);
  const tokenStore = new FileTokenStore(kv);
  const sessionRepository = new FileSessionRepository(kv);

  log.info("Storage initialized", { dataPath });

  await validateStoreFile(dataPath, log);

  // Start proactive token refresh so the plugin always has a valid token
  startTokenRefreshTimer(config, tokenStore);

  // Create event dispatcher
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

if (import.meta.main) {
  main().catch((error) => {
    const log = Log.create({ service: "startup" });
    log.error("Failed to start server", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
