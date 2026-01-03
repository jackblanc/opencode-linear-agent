import { LinearClient } from "@linear/sdk";

/**
 * Refresh token storage structure for KV (permanent)
 */
interface RefreshTokenData {
  refreshToken: string;
  appId: string;
  organizationId: string;
  installedAt: string;
  workspaceName?: string;
}

const LINEAR_OAUTH_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

// Access token TTL: 23 hours (Linear tokens expire after 24 hours)
const ACCESS_TOKEN_TTL_SECONDS = 23 * 60 * 60;

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
  await env.KV.put(`oauth:state:${state}`, "pending", { expirationTtl: 300 });

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

  console.info(`[oauth] Redirecting to Linear OAuth with state ${state}`);

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
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string[];
}> {
  console.info(`[oauth] Exchanging authorization code for token`);

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
    console.error(
      `[oauth] Token exchange failed with status ${response.status}: ${text}`,
    );
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json<{
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string[];
  }>();

  console.info(
    `[oauth] Token exchange successful, expires in ${data.expires_in}s`,
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

/**
 * Refreshes an expired access token using the refresh token
 * Also updates both the access token and refresh token in KV
 */
export async function refreshAccessToken(
  env: Env,
  organizationId: string,
): Promise<string> {
  console.info(`[oauth] Refreshing access token for org ${organizationId}`);

  // Get refresh token data from KV
  const refreshData = await env.KV.get<RefreshTokenData>(
    `token:refresh:${organizationId}`,
    "json",
  );

  if (!refreshData) {
    console.error(`[oauth] No refresh token found for org ${organizationId}`);
    throw new Error(
      `No refresh token found for organization ${organizationId}. Please re-authorize at /oauth/authorize`,
    );
  }
  console.info(`[oauth] Found refresh token for org ${organizationId}`);

  // Exchange refresh token for new tokens
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      refresh_token: refreshData.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `[oauth] Token refresh failed for org ${organizationId} with status ${response.status}: ${text}`,
    );
    throw new Error(
      `Token refresh failed: ${response.status}. Please re-authorize at /oauth/authorize`,
    );
  }

  const data = await response.json<{
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string[];
  }>();

  console.info(
    `[oauth] Token refresh successful for org ${organizationId}, expires in ${data.expires_in}s`,
  );

  // Store new access token with 23-hour TTL
  await env.KV.put(`token:access:${organizationId}`, data.access_token, {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  });

  // Update refresh token data (Linear may rotate refresh tokens)
  const updatedRefreshData: RefreshTokenData = {
    ...refreshData,
    refreshToken: data.refresh_token,
  };
  await env.KV.put(
    `token:refresh:${organizationId}`,
    JSON.stringify(updatedRefreshData),
  );

  return data.access_token;
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
    console.error(
      `[oauth] OAuth error from Linear: ${error} - ${errorDescription ?? "no description"}`,
    );
    return new Response(`OAuth Error: ${error}\n${errorDescription ?? ""}`, {
      status: 400,
    });
  }

  // Validate required parameters
  if (!code) {
    console.warn(`[oauth] Missing code parameter in callback`);
    return new Response("Missing authorization code", { status: 400 });
  }

  if (!state) {
    console.warn(`[oauth] Missing state parameter in callback`);
    return new Response("Missing state parameter", { status: 400 });
  }

  // Validate state parameter against stored value in KV
  const storedState = await env.KV.get(`oauth:state:${state}`);
  if (!storedState) {
    console.warn(`[oauth] Invalid or expired OAuth state: ${state}`);
    return new Response(
      "Invalid or expired state parameter. Please restart the OAuth flow.",
      { status: 403 },
    );
  }

  // Delete state (one-time use)
  await env.KV.delete(`oauth:state:${state}`);
  console.info(`[oauth] State ${state} validated and deleted`);

  try {
    // Exchange code for access token
    const tokenData = await exchangeCodeForToken(code, env, request);

    // Create Linear client to get app and organization info
    const client = new LinearClient({ accessToken: tokenData.accessToken });
    const viewer = await client.viewer;
    const organization = await viewer.organization;

    console.info(
      `[oauth] Retrieved app info: ${viewer.name} (${viewer.id}) in org ${organization.name} (${organization.id})`,
    );

    // Store access token with 23-hour TTL
    await env.KV.put(`token:access:${organization.id}`, tokenData.accessToken, {
      expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
    });

    // Store refresh token data (permanent)
    const refreshData: RefreshTokenData = {
      refreshToken: tokenData.refreshToken,
      appId: viewer.id,
      organizationId: organization.id,
      installedAt: new Date().toISOString(),
      workspaceName: organization.name,
    };
    await env.KV.put(
      `token:refresh:${organization.id}`,
      JSON.stringify(refreshData),
    );

    console.info(
      `[oauth] Tokens stored successfully for org ${organization.id} (app ${viewer.id})`,
    );

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
    <h1>Setup Complete!</h1>
    <p class="success">Your Linear OpenCode Agent is now connected.</p>
    
    <h2>Next Steps:</h2>
    <ul>
      <li><strong>Set LINEAR_ORGANIZATION_ID</strong> in your <code>wrangler.jsonc</code>:
        <br><code>${organization.id}</code>
      </li>
      <li>Re-deploy the worker after updating the config</li>
      <li>Make sure your webhook URL is configured in Linear:
        <br><code>${url.origin}/webhook/linear</code>
      </li>
      <li>Webhook category should be: <strong>Agent session events</strong></li>
    </ul>

    <h2>App Information:</h2>
    <ul>
      <li><strong>Organization ID:</strong> <code>${organization.id}</code></li>
      <li><strong>Organization Name:</strong> ${organization.name}</li>
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[oauth] OAuth callback failed: ${errorMessage}`);

    return new Response(`OAuth setup failed: ${errorMessage}`, { status: 500 });
  }
}
