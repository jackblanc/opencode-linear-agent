import { handleAuthorize, handleCallback } from "./oauth";
import { handleWebhook } from "./webhook";
import { validateApiKey, unauthorizedResponse } from "./auth";
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

    // OAuth endpoints (public, protected by CSRF state)
    if (url.pathname === "/oauth/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/oauth/callback") {
      return handleCallback(request, env);
    }

    // Webhook endpoint (protected by signature verification)
    if (url.pathname === "/webhook/linear") {
      return handleWebhook(request, env, ctx);
    }

    // Health check (public)
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    // OpenCode UI and API routes
    // Auth is required for the main entry point, but static assets and API
    // calls are proxied through (OpenCode handles its own session management)
    const isOpencodeRoute =
      url.pathname.startsWith("/session") ||
      url.pathname.startsWith("/event") ||
      url.pathname.startsWith("/opencode") ||
      url.pathname.startsWith("/assets") ||
      url.pathname.startsWith("/_app") ||
      url.pathname.startsWith("/@") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".ico");

    if (isOpencodeRoute) {
      // Require API key for main entry points, allow assets through
      const isEntryPoint =
        url.pathname === "/opencode" ||
        url.pathname.startsWith("/session") ||
        url.pathname.startsWith("/event");

      if (isEntryPoint && !validateApiKey(request, env)) {
        return unauthorizedResponse();
      }

      const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
      const server = await createOpencodeServer(sandbox, {
        directory: PROJECT_DIR,
        config: getConfig(env),
      });
      return proxyToOpencode(request, sandbox, server);
    }

    // Default response - also protected
    if (!validateApiKey(request, env)) {
      return new Response(
        `
Linear OpenCode Agent

Authentication required.
Add ?key=YOUR_ADMIN_API_KEY to access the OpenCode UI.

Public endpoints:
- GET  /oauth/authorize  - Start OAuth flow
- POST /webhook/linear   - Linear webhook receiver (signature verified)
- GET  /health          - Health check
        `.trim(),
        {
          status: 401,
          headers: {
            "Content-Type": "text/plain",
          },
        },
      );
    }

    return new Response(
      `
Linear OpenCode Agent

Available endpoints:
- GET  /oauth/authorize  - Start OAuth flow
- POST /webhook/linear   - Linear webhook receiver
- GET  /health          - Health check
- GET  /opencode        - OpenCode Web UI

Setup Instructions:
1. Visit /oauth/authorize to connect your Linear workspace
2. Configure webhook URL in Linear app settings
3. Delegate issues to the agent or @mention it

Status: Ready
      `.trim(),
      {
        headers: {
          "Content-Type": "text/plain",
        },
      },
    );
  },
};
