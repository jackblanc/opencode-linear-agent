import { handleAuthorize, handleCallback } from "./oauth";
import { handleWebhook } from "./webhook";
import { validateAuth, unauthorizedResponse, createAuthCookie } from "./auth";
import { proxyToOpencode } from "@cloudflare/sandbox/opencode";
import { getOrInitializeSandbox } from "./sandbox";

export { Sandbox } from "@cloudflare/sandbox";

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
    console.info(`[router] ${request.method} ${url.pathname}`);

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

    // === PROTECTED ROUTES (Basic Auth or cookie required) ===

    // Check if request has Basic Auth header (to determine if we need to set cookie)
    const hasBasicAuthHeader = request.headers
      .get("Authorization")
      ?.startsWith("Basic ");

    if (!(await validateAuth(request, env))) {
      return unauthorizedResponse();
    }

    // All authenticated requests proxy to OpenCode
    const { sandbox, server } = await getOrInitializeSandbox(
      env,
      env.LINEAR_ORGANIZATION_ID,
    );
    const response = await proxyToOpencode(request, sandbox, server);

    // Fix missing/incorrect Content-Type for static assets
    const fixedResponse = fixContentType(response, url.pathname);

    // If authenticated via Basic Auth header, set auth cookie for WebSocket connections
    // WebSocket upgrade requests can't send Authorization headers, but they can send cookies
    if (hasBasicAuthHeader && env.ADMIN_API_KEY) {
      const headers = new Headers(fixedResponse.headers);
      headers.append("Set-Cookie", await createAuthCookie(env.ADMIN_API_KEY));

      return new Response(fixedResponse.body, {
        status: fixedResponse.status,
        statusText: fixedResponse.statusText,
        headers,
      });
    }

    return fixedResponse;
  },
};
