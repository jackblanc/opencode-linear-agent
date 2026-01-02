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

// MIME type mapping for static assets (proxyToOpencode doesn't set these correctly)
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
 * Fix missing or incorrect Content-Type headers from proxyToOpencode.
 * The sandbox proxy returns application/octet-stream or empty Content-Type
 * for static assets, which causes browsers to reject JS/CSS files.
 */
function fixContentType(response: Response, pathname: string): Response {
  const contentType = response.headers.get("Content-Type");

  // Only fix if Content-Type is missing or generic
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
    const response = await proxyToOpencode(request, sandbox, server);

    // Fix missing/incorrect Content-Type for static assets
    return fixContentType(response, url.pathname);
  },
};
