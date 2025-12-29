import { getSandbox } from "@cloudflare/sandbox";
import { handleAuthorize, handleCallback } from "./oauth";
import { handleWebhook } from "./webhook";
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
} from "@cloudflare/sandbox/opencode";
import { OpencodeClient } from "@opencode-ai/sdk";

export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Get or create a sandbox instance
    const sandbox = getSandbox(env.Sandbox, "linear-opencode-agent");

    // Ensure the project directory exists
    const projectDir = "/home/user/project";
    await sandbox.exec(`mkdir -p ${projectDir}`);

    // OpenCode Web UI - proxy only /opencode requests
    if (url.pathname.startsWith("/opencode")) {
      const server = await createOpencodeServer(sandbox, {
        directory: projectDir,
        config: {
          provider: {
            anthropic: {
              options: {
                apiKey: env.ANTHROPIC_API_KEY,
              },
            },
          },
        },
      });
      return proxyToOpencode(request, sandbox, server);
    }

    // Programmatic SDK access example
    if (url.pathname === "/api/session") {
      const { client } = await createOpencode<OpencodeClient>(sandbox, {
        directory: projectDir,
        config: {
          provider: {
            anthropic: {
              options: {
                apiKey: env.ANTHROPIC_API_KEY,
              },
            },
          },
        },
      });

      // Create a new session
      const session = await client.session.create({
        body: { title: "Linear Agent Task" },
      });

      if (!session.data) {
        return Response.json(
          { error: "Failed to create session" },
          { status: 500 },
        );
      }

      return Response.json({
        sessionId: session.data.id,
        title: session.data.title,
      });
    }

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
      return handleWebhook(request, env);
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    // Default response
    return new Response(
      `
Linear OpenCode Agent

Available endpoints:
- GET  /oauth/authorize  - Start OAuth flow
- POST /webhook/linear   - Linear webhook receiver
- GET  /health          - Health check

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
