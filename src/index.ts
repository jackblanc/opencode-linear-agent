import { handleAuthorize, handleCallback } from "./oauth";
import { handleWebhook } from "./webhook";
import { getSandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { getConfig } from "./config";

export { Sandbox } from "@cloudflare/sandbox";

// Default sandbox ID for web UI and test endpoint
const DEFAULT_SANDBOX_ID = "opencode-dev";
const PROJECT_DIR = "/home/user/project";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    console.debug("Request received", {
      method: request.method,
      pathname: url.pathname,
    });

    // OAuth endpoints
    if (url.pathname === "/oauth/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/oauth/callback") {
      return handleCallback(request, env);
    }

    // Webhook endpoint
    if (url.pathname === "/webhook/linear") {
      return handleWebhook(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    // Programmatic SDK test endpoint
    if (request.method === "POST" && url.pathname === "/api/test") {
      return handleSdkTest(env);
    }

    // OpenCode Web UI - proxy all other requests to OpenCode
    if (
      url.pathname.startsWith("/session") ||
      url.pathname.startsWith("/event") ||
      url.pathname === "/opencode" ||
      url.pathname.startsWith("/opencode/")
    ) {
      const sandbox = getSandbox(env.Sandbox, DEFAULT_SANDBOX_ID);
      const server = await createOpencodeServer(sandbox, {
        directory: PROJECT_DIR,
        config: getConfig(env),
      });
      return proxyToOpencode(request, sandbox, server);
    }

    // Default response
    return new Response(
      `
Linear OpenCode Agent

Available endpoints:
- GET  /oauth/authorize  - Start OAuth flow
- POST /webhook/linear   - Linear webhook receiver
- GET  /health          - Health check
- POST /api/test        - Test OpenCode SDK programmatically
- GET  /opencode        - OpenCode Web UI (dev/debug)

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

/**
 * Test the programmatic SDK access
 */
async function handleSdkTest(env: Env): Promise<Response> {
  try {
    const sandbox = getSandbox(env.Sandbox, DEFAULT_SANDBOX_ID);

    // Ensure project directory exists
    await sandbox.exec(`mkdir -p ${PROJECT_DIR}`, { timeout: 30000 });

    // Get typed SDK client
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: PROJECT_DIR,
      config: getConfig(env),
    });

    // Create a session
    const session = await client.session.create({
      body: { title: "Test Session" },
      query: { directory: PROJECT_DIR },
    });

    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Send a prompt using the SDK
    const promptResult = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory: PROJECT_DIR },
      body: {
        model: {
          providerID: "anthropic",
          modelID: "claude-haiku-4-5",
        },
        parts: [
          {
            type: "text",
            text: "Say hello in exactly 5 words.",
          },
        ],
      },
    });

    // Extract text response from result
    const parts = promptResult.data?.parts ?? [];
    const textPart = parts.find((p: { type: string }) => p.type === "text") as
      | { text?: string }
      | undefined;

    return new Response(textPart?.text ?? "No response", {
      headers: { "Content-Type": "text/plain" },
    });
  } catch (error) {
    console.error("SDK test error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const stack = error instanceof Error ? error.stack : undefined;
    return Response.json(
      { success: false, error: message, stack },
      { status: 500 },
    );
  }
}
