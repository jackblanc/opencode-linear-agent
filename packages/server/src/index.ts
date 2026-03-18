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
 * - Configuration file at XDG config directory with necessary values (see README)
 * - Local repository at the configured projects path
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
} from "@linear/sdk/webhooks";
import {
  IssueEventHandler,
  WorktreeManager,
  createFileLogSink,
  handleAuthorize,
  handleCallback,
  handleWebhook,
  refreshAccessToken,
  LinearServiceImpl,
  OpencodeService,
  Log,
  FileStore,
  FileTokenStore,
  FileSessionRepository,
  type EventDispatcher,
  type KeyValueStore,
  type LogSink,
  type OAuthConfig,
  type TokenStore,
} from "@opencode-linear-agent/core";
import {
  createServerLogPath,
  getLogDir,
  loadConfig,
  type Config,
} from "./config";
import { dispatchAgentSessionEvent } from "./AgentSessionDispatcher";
import { mkdir } from "node:fs/promises";

export interface ServerLoggingRuntime {
  log: ReturnType<typeof Log.create>;
  logPath: string;
  sink: LogSink;
}

let serverLoggingRuntime: ServerLoggingRuntime | null = null;
let serverLoggingRuntimePromise: Promise<ServerLoggingRuntime> | null = null;

async function createServerLoggingRuntime(): Promise<ServerLoggingRuntime> {
  const logDir = getLogDir();
  const logPath = createServerLogPath();

  await mkdir(logDir, { recursive: true });

  const sink = await createFileLogSink(logPath);
  Log.init({ sink });

  const runtime = {
    log: Log.create({ service: "startup" }),
    logPath,
    sink,
  } satisfies ServerLoggingRuntime;

  serverLoggingRuntime = runtime;
  return runtime;
}

export async function initializeServerLogging(): Promise<ServerLoggingRuntime> {
  if (serverLoggingRuntime) {
    return serverLoggingRuntime;
  }

  serverLoggingRuntimePromise ??= createServerLoggingRuntime().catch(
    async (error: unknown) => {
      serverLoggingRuntimePromise = null;
      throw error;
    },
  );

  return serverLoggingRuntimePromise;
}

export async function shutdownServerLogging(
  logging: ServerLoggingRuntime,
  signal: string,
): Promise<void> {
  logging.log.info("Shutting down", { signal });
  await Log.shutdown();
}

function registerShutdownHandlers(
  server: ReturnType<typeof Bun.serve>,
  logging: ServerLoggingRuntime,
): void {
  let shutdown: Promise<void> | null = null;

  const run = (signal: string): void => {
    shutdown ??= shutdownServerLogging(logging, signal).then(
      () => {
        void server.stop(true);
        process.exit(0);
      },
      (error: unknown) => {
        void server.stop(true);
        process.stderr.write(
          `shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", () => run("SIGINT"));
  process.once("SIGTERM", () => run("SIGTERM"));
}

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
    baseUrl: config.opencodeServerUrl,
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
            clientId: config.linearClientId,
            clientSecret: config.linearClientSecret,
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
          clientId: config.linearClientId,
          clientSecret: config.linearClientSecret,
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
    clientId: config.linearClientId,
    clientSecret: config.linearClientSecret,
    baseUrl: `https://${config.webhookServerPublicHostname}`,
  };

  return Bun.serve({
    port: config.webhookServerPort,
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

      if (pathname === "/health") {
        return respond(new Response("OK", { status: 200 }));
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

      // Linear webhook endpoint - receive events from Linear (issue updates, agent events, etc.)
      if (pathname === "/api/webhook/linear") {
        // IP allowlist check - only Linear's servers can call this endpoint
        if (!isAllowedIp(clientIp, config.linearWebhookIps)) {
          log.warn("Webhook request from unauthorized IP", {
            clientIp,
            allowedIps: config.linearWebhookIps,
          });
          return respond(new Response("Forbidden", { status: 403 }));
        }

        return respond(
          await handleWebhook(
            request,
            config.linearWebhookSecret,
            tokenStore,
            dispatcher,
            undefined, // statusPosterFactory
            config.linearOrganizationId, // only accept webhooks from this org
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
  const organizationId = config.linearOrganizationId;
  if (!organizationId) {
    log.info(
      "Skipping proactive token refresh (LINEAR_ORGANIZATION_ID not set)",
    );
    return;
  }
  const oauthConfig: OAuthConfig = {
    clientId: config.linearClientId,
    clientSecret: config.linearClientSecret,
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

/**
 * Main entry point
 */
async function main(): Promise<ReturnType<typeof Bun.serve>> {
  const logging = await initializeServerLogging();
  const log = logging.log;
  const logPath = logging.logPath;
  log.info("Starting Linear OpenCode Agent (Local)");

  // Load configuration
  const config = loadConfig();

  log.info("Configuration loaded", {
    port: config.webhookServerPort,
    publicHostname: config.webhookServerPublicHostname,
    opencodeUrl: config.opencodeServerUrl,
    projectsPath: config.projectsPath,
  });

  const kv = new FileStore();
  const tokenStore = new FileTokenStore(kv);
  const sessionRepository = new FileSessionRepository(kv);

  log.info("Storage initialized", { logPath });

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
  registerShutdownHandlers(server, logging);

  const webhookServerUrl = `https://${config.webhookServerPublicHostname}`;
  log.info("Server started", {
    port: config.webhookServerPort,
    webhookServerUrl,
    webhookUrl: `${webhookServerUrl}/api/webhook/linear`,
    oauthUrl: `${webhookServerUrl}/api/oauth/authorize`,
  });

  // Banner output - use process.stdout directly for multi-line
  process.stdout.write(`
Linear OpenCode Agent (Local) running!

  Local:    http://localhost:${config.webhookServerPort}
  Public:   ${webhookServerUrl}

  Webhook URL: ${webhookServerUrl}/api/webhook/linear
  OAuth URL:   ${webhookServerUrl}/api/oauth/authorize

Make sure OpenCode is running: opencode serve
`);

  return server;
}

if (import.meta.main) {
  void main().catch(async (error: unknown) => {
    const log = Log.create({ service: "startup" });
    log.error("Failed to start server", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (serverLoggingRuntime) {
      await Log.shutdown();
    }

    process.exit(1);
  });
}
