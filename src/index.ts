import { getSandbox } from "@cloudflare/sandbox";
import {
  createOpencodeServer,
  proxyToOpencode,
  createOpencode,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";

export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Get or create a sandbox instance
    const sandbox = getSandbox(env.Sandbox, "linear-opencode-agent");

    // OpenCode Web UI - proxy all requests to the OpenCode server
    if (url.pathname.startsWith("/opencode") || url.pathname === "/") {
      const server = await createOpencodeServer(sandbox, {
        directory: "/home/user/project",
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
        directory: "/home/user/project",
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
          { status: 500 }
        );
      }

      return Response.json({
        sessionId: session.data.id,
        title: session.data.title,
      });
    }

    // Execute a shell command (example)
    if (url.pathname === "/run") {
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return Response.json({
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode,
        success: result.success,
      });
    }

    // Work with files (example)
    if (url.pathname === "/file") {
      await sandbox.writeFile("/workspace/hello.txt", "Hello, Sandbox!");
      const file = await sandbox.readFile("/workspace/hello.txt");
      return Response.json({
        content: file.content,
      });
    }

    return new Response(
      "OpenCode Agent for Linear\n\nAvailable endpoints:\n- / (OpenCode Web UI)\n- /api/session (Create session)\n- /run (Execute command)\n- /file (File operations)"
    );
  },
};
