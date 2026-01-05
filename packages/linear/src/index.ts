/**
 * Linear Worker - handles webhooks and OAuth
 *
 * This worker is responsible for:
 * - Receiving Linear webhooks and enqueueing them for processing
 * - Handling OAuth flow for workspace installation
 * - Health checks
 *
 * The actual event processing happens in the Agent worker (queue consumer).
 */

import { handleHealth } from "./routes/health";
import { handleWebhook } from "./routes/webhook";
import { handleAuthorize, handleCallback } from "./routes/oauth";
import { KVStore, KVTokenStore } from "@linear-opencode-agent/infrastructure";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    console.info(`[linear] ${request.method} ${url.pathname}`);

    // Create infrastructure instances
    const kv = new KVStore(env.KV);
    const tokenStore = new KVTokenStore(kv);

    // Health check
    if (url.pathname === "/api/health") {
      return handleHealth();
    }

    // Webhook - protected by signature verification
    if (
      url.pathname === "/webhook/linear" ||
      url.pathname === "/api/webhook/linear"
    ) {
      return handleWebhook(request, {
        LINEAR_WEBHOOK_SECRET: env.LINEAR_WEBHOOK_SECRET,
        AGENT_QUEUE: env.AGENT_QUEUE,
      });
    }

    // OAuth authorize
    if (url.pathname === "/api/oauth/authorize") {
      return handleAuthorize(request, env, kv);
    }

    // OAuth callback
    if (url.pathname === "/api/oauth/callback") {
      return handleCallback(request, env, kv, tokenStore);
    }

    return new Response("Not found", { status: 404 });
  },
};
