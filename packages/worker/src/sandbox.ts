/**
 * Unified sandbox initialization module.
 *
 * Provides a single mechanism for:
 * - Starting the sandbox container
 * - Mounting R2 bucket for session persistence
 * - Setting environment variables (including LINEAR_ACCESS_TOKEN)
 * - Creating OpenCode client and server
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  type createOpencodeServer,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { getConfig } from "./config";
import { refreshAccessToken } from "./oauth";

// Shared sandbox ID for all OpenCode access (web UI and Linear webhooks)
export const SANDBOX_ID = "opencode-instance";

// Default working directory in Cloudflare Sandbox (matches gitCheckout default)
export const PROJECT_DIR = "/workspace";

// Port used by OpenCode server (default)
export const OPENCODE_PORT = 4096;

// XDG_DATA_HOME default for root user
const XDG_DATA_HOME = "/root/.local/share";

// Mount R2 at OpenCode's storage directory specifically
// This persists session data while keeping logs/auth/binaries ephemeral
const OPENCODE_STORAGE_PATH = `${XDG_DATA_HOME}/opencode/storage`;

/**
 * Result from getOrInitializeSandbox
 */
export interface SandboxContext {
  sandbox: Sandbox;
  client: OpencodeClient;
  server: Awaited<ReturnType<typeof createOpencodeServer>>;
}

/**
 * Get or initialize the OpenCode sandbox with all required setup.
 *
 * This unified method handles:
 * - Starting the sandbox container
 * - Mounting R2 bucket for session persistence
 * - Setting LINEAR_ACCESS_TOKEN environment variable
 * - Creating OpenCode client and server
 *
 * @param env - Worker environment
 * @param organizationId - Linear organization ID (used to fetch/refresh access token)
 * @throws Error if R2 bucket fails to mount in production
 * @throws Error if Linear access token cannot be obtained
 */
export async function getOrInitializeSandbox(
  env: Env,
  organizationId: string,
): Promise<SandboxContext> {
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

  console.info("Starting sandbox container");
  await sandbox.start();
  console.info("Sandbox container started");

  // Mount R2 at OpenCode's storage directory for session persistence
  try {
    await sandbox.mountBucket("opencode-data", OPENCODE_STORAGE_PATH, {
      endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    });
    console.info("R2 bucket mounted at", OPENCODE_STORAGE_PATH);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes("already in use")) {
      // Bucket already mounted - this is fine
      console.info("R2 bucket already mounted");
    } else if (errorMessage.includes("wrangler dev")) {
      // Local development - mountBucket not supported, continue without persistence
      console.warn(
        "R2 bucket mounting not available in local dev, continuing without persistence",
      );
    } else {
      // Production mount failure - throw
      throw new Error(`Failed to mount R2 bucket: ${errorMessage}`, {
        cause: error,
      });
    }
  }

  // Get Linear access token (refresh if expired)
  let accessToken = await env.KV.get(`token:access:${organizationId}`);
  if (!accessToken) {
    console.info("Access token expired, refreshing...", { organizationId });
    accessToken = await refreshAccessToken(env, organizationId);
  }

  // Set environment variables for the container
  await sandbox.setEnvVars({
    LINEAR_ACCESS_TOKEN: accessToken,
  });

  // Ensure project directory exists
  await sandbox.exec(`mkdir -p ${PROJECT_DIR}`, { timeout: 30000 });

  // Create OpenCode client and server
  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    port: OPENCODE_PORT,
    directory: PROJECT_DIR,
    config: getConfig(env),
  });

  return { sandbox, client, server };
}

/**
 * Get or initialize sandbox using the default organization from env vars.
 * Use this when organization ID is not available from context (e.g., web UI).
 *
 * @param env - Worker environment
 * @throws Error if LINEAR_ORGANIZATION_ID is not configured
 */
export async function getOrInitializeSandboxDefault(
  env: Env,
): Promise<SandboxContext> {
  const organizationId = env.LINEAR_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error(
      "LINEAR_ORGANIZATION_ID not configured. Please set it in wrangler.jsonc after completing OAuth.",
    );
  }

  return getOrInitializeSandbox(env, organizationId);
}

/**
 * Get the sandbox instance without initialization.
 * Use this when you need direct sandbox access (e.g., for gitCheckout).
 */
export function getSandboxInstance(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID);
}
