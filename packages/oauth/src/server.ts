/**
 * Local OAuth callback server for Linear authentication.
 * Handles the OAuth redirect and exchanges the authorization code for tokens.
 *
 * Note: This module uses Bun APIs and is intended for local CLI usage.
 */

import { Result } from "better-result";
import { OAuthCallbackError } from "./errors";

const DEFAULT_PORT = 14550;
const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Linear - Authorization Successful</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #eee;
    }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #5E6AD2; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;

function htmlError(error: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Linear - Authorization Failed</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #eee;
    }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error {
      color: #fca5a5;
      font-family: monospace;
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(248,113,113,0.1);
      border-radius: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`;
}

interface PendingAuth {
  resolve: (result: Result<string, OAuthCallbackError>) => void;
  timeout: ReturnType<typeof setTimeout>;
  expectedState: string;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let pendingAuth: PendingAuth | undefined;
let currentPort = DEFAULT_PORT;

/**
 * Generate a cryptographically secure state parameter for CSRF protection.
 */
export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Start the local OAuth callback server.
 */
export function startServer(port: number = DEFAULT_PORT): void {
  if (server) {
    return;
  }

  currentPort = port;

  server = Bun.serve({
    port: currentPort,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== CALLBACK_PATH) {
        return new Response("Not found", { status: 404 });
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      // Validate state parameter for CSRF protection
      if (!state || state !== pendingAuth?.expectedState) {
        const msg = "Invalid state parameter - possible CSRF attack";
        pendingAuth?.resolve(Result.err(new OAuthCallbackError(msg)));
        pendingAuth = undefined;
        return new Response(htmlError(msg), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (error) {
        const msg = errorDescription ?? error;
        pendingAuth?.resolve(Result.err(new OAuthCallbackError(msg)));
        pendingAuth = undefined;
        return new Response(htmlError(msg), {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!code) {
        const msg = "Missing authorization code";
        pendingAuth?.resolve(Result.err(new OAuthCallbackError(msg)));
        pendingAuth = undefined;
        return new Response(htmlError(msg), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      // Resolve the pending auth with the code
      pendingAuth?.resolve(Result.ok(code));
      pendingAuth = undefined;

      return new Response(HTML_SUCCESS, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
}

/**
 * Stop the OAuth callback server.
 */
export async function stopServer(): Promise<void> {
  if (server) {
    await server.stop();
    server = undefined;
  }

  if (pendingAuth) {
    clearTimeout(pendingAuth.timeout);
    pendingAuth = undefined;
  }
}

/**
 * Wait for the OAuth callback to complete.
 * Returns the authorization code or an error.
 * @param expectedState - The state parameter to validate against for CSRF protection
 */
export async function waitForCallback(
  expectedState: string,
): Promise<Result<string, OAuthCallbackError>> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingAuth) {
        clearTimeout(pendingAuth.timeout);
        pendingAuth = undefined;
        resolve(
          Result.err(
            new OAuthCallbackError("Timeout - authorization took too long"),
          ),
        );
      }
    }, CALLBACK_TIMEOUT_MS);

    // Wrap resolve to clear timeout when callback succeeds
    const wrappedResolve = (
      result: Result<string, OAuthCallbackError>,
    ): void => {
      clearTimeout(timeout);
      resolve(result);
    };

    pendingAuth = { resolve: wrappedResolve, timeout, expectedState };
  });
}

/**
 * Get the redirect URI for OAuth.
 */
export function getRedirectUri(port: number = currentPort): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

export { DEFAULT_PORT, CALLBACK_PATH };
