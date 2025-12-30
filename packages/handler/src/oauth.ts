import { LinearClient } from "@linear/sdk";

/**
 * Token storage structure for KV
 */
interface LinearTokenData {
  accessToken: string;
  appId: string;
  organizationId: string;
  installedAt: string;
  workspaceName?: string;
}

const LINEAR_OAUTH_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * Required OAuth scopes for the agent
 */
const REQUIRED_SCOPES = ["write", "app:mentionable", "app:assignable"];

/**
 * Handles the /oauth/authorize endpoint
 * Redirects to Linear OAuth flow
 */
export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  // Generate CSRF state token
  const state = crypto.randomUUID();

  // Store state in KV with 5-minute TTL for CSRF protection
  await env.OAUTH_STATES.put(state, "pending", { expirationTtl: 300 });

  // Generate callback URL from the request origin
  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/oauth/callback`;

  // Generate auth URL
  const params = new URLSearchParams({
    client_id: env.LINEAR_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(","),
    state,
    actor: "app", // Important: authenticate as app, not user
  });

  const authUrl = `${LINEAR_OAUTH_URL}?${params.toString()}`;

  console.info("Redirecting to Linear OAuth", { state });

  return Response.redirect(authUrl, 302);
}

/**
 * Exchanges authorization code for access token
 */
async function exchangeCodeForToken(
  code: string,
  env: Env,
  request: Request,
): Promise<{
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string[];
}> {
  console.debug("Exchanging code for token");

  // Generate callback URL from the request origin
  const requestUrl = new URL(request.url);
  const callbackUrl = `${requestUrl.origin}/oauth/callback`;

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      redirect_uri: callbackUrl,
      code,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Token exchange failed", undefined, {
      status: response.status,
      body: text,
    });
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json<{
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string[];
  }>();

  console.info("Token exchange successful");

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

/**
 * Handles the /oauth/callback endpoint
 * Receives authorization code, exchanges for token, stores in KV
 */
export async function handleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Handle OAuth errors
  if (error) {
    console.error("OAuth error from Linear", undefined, {
      error,
      errorDescription,
    });

    return new Response(`OAuth Error: ${error}\n${errorDescription || ""}`, {
      status: 400,
    });
  }

  // Validate required parameters
  if (!code) {
    console.warn("Missing code parameter in callback");
    return new Response("Missing authorization code", { status: 400 });
  }

  if (!state) {
    console.warn("Missing state parameter in callback");
    return new Response("Missing state parameter", { status: 400 });
  }

  // Validate state parameter against stored value in KV
  const storedState = await env.OAUTH_STATES.get(state);
  if (!storedState) {
    console.warn("Invalid or expired OAuth state", { state });
    return new Response(
      "Invalid or expired state parameter. Please restart the OAuth flow.",
      { status: 403 },
    );
  }

  // Delete state (one-time use)
  await env.OAUTH_STATES.delete(state);
  console.debug("State validated successfully");

  try {
    // Exchange code for access token
    const tokenData = await exchangeCodeForToken(code, env, request);

    // Create Linear client to get app and organization info
    const client = new LinearClient({ accessToken: tokenData.accessToken });
    const viewer = await client.viewer;
    const organization = await viewer.organization;

    console.info("Retrieved app and organization info", {
      appId: viewer.id,
      appName: viewer.name,
      organizationId: organization.id,
      organizationName: organization.name,
    });

    // Store token data in KV using organization ID as key
    const tokenStorageData: LinearTokenData = {
      accessToken: tokenData.accessToken,
      appId: viewer.id,
      organizationId: organization.id,
      installedAt: new Date().toISOString(),
      workspaceName: organization.name,
    };

    // Store with organization ID - this matches what webhooks provide
    await env.LINEAR_TOKENS.put(
      `org:${organization.id}`,
      JSON.stringify(tokenStorageData),
    );

    console.info("Token stored successfully", {
      key: `org:${organization.id}`,
      appId: viewer.id,
    });

    // Return success page
    return new Response(
      `
<!DOCTYPE html>
<html>
<head>
  <title>Linear OpenCode Agent - Setup Complete</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .card {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 { color: #5E6AD2; margin-top: 0; }
    .success { color: #0c8043; font-weight: 600; }
    code {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    ul { line-height: 1.8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✓ Setup Complete!</h1>
    <p class="success">Your Linear OpenCode Agent is now connected.</p>
    
    <h2>Next Steps:</h2>
    <ul>
      <li>Make sure your webhook URL is configured in Linear:
        <br><code>${url.origin}/webhook/linear</code>
      </li>
      <li>Webhook category should be: <strong>Agent session events</strong></li>
      <li>Delegate a Linear issue to your agent or @mention it in a comment</li>
      <li>Specify a GitHub repository URL in the issue description or comment</li>
    </ul>

    <h2>App Information:</h2>
    <ul>
      <li><strong>App ID:</strong> ${viewer.id}</li>
      <li><strong>App Name:</strong> ${viewer.name}</li>
      <li><strong>Installed:</strong> ${new Date().toLocaleString()}</li>
    </ul>

    <p><small>You can close this window.</small></p>
  </div>
</body>
</html>
      `.trim(),
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      },
    );
  } catch (error) {
    console.error("OAuth callback failed", error);

    return new Response(
      `OAuth setup failed: ${error instanceof Error ? error.message : String(error)}`,
      { status: 500 },
    );
  }
}
