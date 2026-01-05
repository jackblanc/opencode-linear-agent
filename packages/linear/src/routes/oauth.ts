import { LinearClient } from "@linear/sdk";
import type {
  KeyValueStore,
  TokenStore,
  RefreshTokenData,
} from "@linear-opencode-agent/infrastructure";

const LINEAR_OAUTH_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

// Access token TTL: 23 hours (Linear tokens expire after 24 hours)
const ACCESS_TOKEN_TTL_SECONDS = 23 * 60 * 60;

/**
 * Required OAuth scopes for the agent
 */
const REQUIRED_SCOPES = ["write", "app:mentionable", "app:assignable"];

/**
 * Environment bindings required for OAuth
 */
interface OAuthEnv {
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
}

/**
 * Handle /oauth/authorize - redirect to Linear OAuth flow
 */
export async function handleAuthorize(
  request: Request,
  env: OAuthEnv,
  kv: KeyValueStore,
): Promise<Response> {
  // Generate CSRF state token
  const state = crypto.randomUUID();

  // Store state in KV with 5-minute TTL for CSRF protection
  await kv.put(`oauth:state:${state}`, "pending", { expirationTtl: 300 });

  // Generate callback URL from the request origin
  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/api/oauth/callback`;

  // Generate auth URL
  const params = new URLSearchParams({
    client_id: env.LINEAR_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(","),
    state,
    actor: "app", // Authenticate as app, not user
  });

  const authUrl = `${LINEAR_OAUTH_URL}?${params.toString()}`;
  console.info(`[oauth] Redirecting to Linear OAuth with state ${state}`);

  return Response.redirect(authUrl, 302);
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForToken(
  code: string,
  env: OAuthEnv,
  request: Request,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const requestUrl = new URL(request.url);
  const callbackUrl = `${requestUrl.origin}/api/oauth/callback`;

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
    console.error(`[oauth] Token exchange failed: ${response.status}: ${text}`);
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Handle /oauth/callback - exchange code for token and store
 */
export async function handleCallback(
  request: Request,
  env: OAuthEnv,
  kv: KeyValueStore,
  tokenStore: TokenStore,
): Promise<Response> {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    console.error(`[oauth] OAuth error: ${error} - ${errorDescription ?? ""}`);
    return new Response(`OAuth Error: ${error}\n${errorDescription ?? ""}`, {
      status: 400,
    });
  }

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  if (!state) {
    return new Response("Missing state parameter", { status: 400 });
  }

  // Validate state
  const storedState = await kv.getString(`oauth:state:${state}`);
  if (!storedState) {
    return new Response("Invalid or expired state parameter", { status: 403 });
  }

  // Delete state (one-time use)
  await kv.delete(`oauth:state:${state}`);

  try {
    const tokenData = await exchangeCodeForToken(code, env, request);

    // Get organization info
    const client = new LinearClient({ accessToken: tokenData.accessToken });
    const viewer = await client.viewer;
    const organization = await viewer.organization;

    console.info(
      `[oauth] Retrieved app info: ${viewer.name} (${viewer.id}) in org ${organization.name} (${organization.id})`,
    );

    // Store tokens
    await tokenStore.setAccessToken(
      organization.id,
      tokenData.accessToken,
      ACCESS_TOKEN_TTL_SECONDS,
    );

    const refreshData: RefreshTokenData = {
      refreshToken: tokenData.refreshToken,
      appId: viewer.id,
      organizationId: organization.id,
      installedAt: new Date().toISOString(),
      workspaceName: organization.name,
    };
    await tokenStore.setRefreshTokenData(organization.id, refreshData);

    console.info(`[oauth] Tokens stored for org ${organization.id}`);

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
        <br><code>${url.origin}/api/webhook/linear</code>
      </li>
      <li>Webhook category should be: <strong>Agent session events</strong></li>
    </ul>

    <h2>App Information:</h2>
    <ul>
      <li><strong>Organization ID:</strong> <code>${organization.id}</code></li>
      <li><strong>Organization Name:</strong> ${organization.name}</li>
      <li><strong>App ID:</strong> ${viewer.id}</li>
      <li><strong>App Name:</strong> ${viewer.name}</li>
    </ul>

    <p><small>You can close this window.</small></p>
  </div>
</body>
</html>
      `.trim(),
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[oauth] Callback failed: ${errorMessage}`);
    return new Response(`OAuth setup failed: ${errorMessage}`, { status: 500 });
  }
}

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(
  env: OAuthEnv,
  tokenStore: TokenStore,
  organizationId: string,
): Promise<string> {
  console.info(`[oauth] Refreshing access token for org ${organizationId}`);

  const refreshData = await tokenStore.getRefreshTokenData(organizationId);
  if (!refreshData) {
    throw new Error(
      `No refresh token found for organization ${organizationId}. Please re-authorize.`,
    );
  }

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
    console.error(`[oauth] Token refresh failed: ${response.status}: ${text}`);
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await response.json<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>();

  // Store new tokens
  await tokenStore.setAccessToken(
    organizationId,
    data.access_token,
    ACCESS_TOKEN_TTL_SECONDS,
  );

  // Update refresh token (Linear may rotate it)
  const updatedRefreshData: RefreshTokenData = {
    ...refreshData,
    refreshToken: data.refresh_token,
  };
  await tokenStore.setRefreshTokenData(organizationId, updatedRefreshData);

  console.info(`[oauth] Token refreshed for org ${organizationId}`);
  return data.access_token;
}
