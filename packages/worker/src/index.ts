import { handleAuthorize, handleCallback } from "./oauth";
import { handleWebhook } from "./webhook";
import { validateBasicAuth, unauthorizedResponse } from "./auth";
import { getSandbox } from "@cloudflare/sandbox";
import {
  createOpencodeServer,
  proxyToOpencode,
} from "@cloudflare/sandbox/opencode";
import { getConfig } from "./config";

export { Sandbox } from "@cloudflare/sandbox";

// Shared sandbox ID for all OpenCode access (web UI and Linear webhooks)
const SANDBOX_ID = "opencode-instance";
// Default working directory in Cloudflare Sandbox (matches gitCheckout default)
const PROJECT_DIR = "/workspace";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    console.log("Request received", {
      method: request.method,
      pathname: url.pathname,
    });

    // === PUBLIC ROUTES (no auth required) ===

    // Linear webhook - protected by signature verification
    // Support both /webhook/linear (legacy) and /api/webhook/linear
    if (
      url.pathname === "/webhook/linear" ||
      url.pathname === "/api/webhook/linear"
    ) {
      return handleWebhook(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    // OAuth endpoints - protected by CSRF state
    if (url.pathname === "/api/oauth/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/api/oauth/callback") {
      return handleCallback(request, env);
    }

    // === PROTECTED ROUTES (Basic Auth required) ===

    if (!validateBasicAuth(request, env)) {
      return unauthorizedResponse();
    }

    // All authenticated requests proxy to OpenCode
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
    const server = await createOpencodeServer(sandbox, {
      directory: PROJECT_DIR,
      config: getConfig(env),
    });
    return proxyToOpencode(request, sandbox, server);
  },
};
