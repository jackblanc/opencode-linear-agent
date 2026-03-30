import {
  loadApplicationConfig,
  createFileAgentState,
  Log,
  AuthRepository,
  SessionRepository,
  OpencodeService,
  type ApplicationConfig,
  OAuthStateRepository,
} from "@opencode-linear-agent/core";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { getConnInfo } from "hono/bun";
import { refreshAccessToken } from "./token";
import { initializeServerLogging, registerShutdownHandlers } from "./logging";
import { createApp } from "./app";

/**
 * Proactively refresh the access token on a timer so the plugin
 * always has a valid token in the shared store.
 * Token TTL is 23 hours; we refresh every 20 hours for a 3-hour buffer.
 */
function startTokenRefreshTimer(
  config: ApplicationConfig,
  authRepository: AuthRepository,
): void {
  const log = Log.create({ service: "token-refresh" });
  const organizationId = config.linearOrganizationId;
  if (!organizationId) {
    log.info(
      "Skipping proactive token refresh (LINEAR_ORGANIZATION_ID not set)",
    );
    return;
  }
  const oauthConfig = {
    clientId: config.linearClientId,
    clientSecret: config.linearClientSecret,
  };

  const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

  const refresh = async (): Promise<void> => {
    try {
      await refreshAccessToken(authRepository, oauthConfig, organizationId);
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
  const serverLoggingRuntime = await initializeServerLogging();
  const log = serverLoggingRuntime.log;

  log.info("Starting Linear OpenCode Agent (Local)");
  // Load configuration
  const config = loadApplicationConfig();
  log.info("Configuration loaded", {
    port: config.webhookServerPort,
    publicHostname: config.webhookServerPublicHostname,
    opencodeUrl: config.opencodeServerUrl,
    projectsPath: config.projectsPath,
  });

  const agentState = createFileAgentState();

  const oauthStateRepository = new OAuthStateRepository(agentState);
  const authRepository = new AuthRepository(agentState);
  const sessionRepository = new SessionRepository(agentState);

  // Start proactive token refresh so the plugin always has a valid token
  startTokenRefreshTimer(config, authRepository);

  // Start server
  const opencodeClient = createOpencodeClient({
    baseUrl: config.opencodeServerUrl,
  });
  const opencode = new OpencodeService(opencodeClient);
  const app = createApp(
    config,
    oauthStateRepository,
    authRepository,
    sessionRepository,
    opencode,
    getConnInfo,
  );
  const server = Bun.serve({
    port: config.webhookServerPort,
    fetch: app.fetch,
  });
  registerShutdownHandlers(server, serverLoggingRuntime);

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

    await Log.shutdown();

    process.exit(1);
  });
}
