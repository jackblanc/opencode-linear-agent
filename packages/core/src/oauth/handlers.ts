/**
 * OAuth handlers for Linear authentication - platform agnostic
 */

import { LinearClient } from "@linear/sdk";
import type { KeyValueStore, TokenStore, RefreshTokenData } from "../storage";
import type { OAuthConfig, OAuthCallbackResult } from "./types";
import { Log } from "../logger";

const LINEAR_OAUTH_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * OAuth token response from Linear
 */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Parse JSON response with proper typing
 * This helper handles the type difference between Cloudflare (any) and standard (unknown)
 */
async function parseTokenResponse(response: Response): Promise<TokenResponse> {
  const json: unknown = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON parsing requires type assertion
  return json as TokenResponse;
}

// Access token TTL: 23 hours (Linear tokens expire after 24 hours)
const ACCESS_TOKEN_TTL_SECONDS = 23 * 60 * 60;

/**
 * Required OAuth scopes for the agent
 */
const REQUIRED_SCOPES = ["write", "app:mentionable", "app:assignable"];

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForToken(
  code: string,
  config: OAuthConfig,
  callbackUrl: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callbackUrl,
      code,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const log = Log.create({ service: "oauth" });
    log.error("Token exchange failed", {
      status: response.status,
      response: text,
    });
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await parseTokenResponse(response);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Generate the success HTML page after OAuth callback
 */
function generateSuccessHtml(result: OAuthCallbackResult): string {
  return `
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
      <li><strong>Set LINEAR_ORGANIZATION_ID</strong> in your config:
        <br><code>${result.organizationId}</code>
      </li>
      <li>Make sure your webhook URL is configured in Linear:
        <br><code>${result.webhookUrl}</code>
      </li>
      <li>Webhook category should be: <strong>Agent session events</strong></li>
    </ul>

    <h2>App Information:</h2>
    <ul>
      <li><strong>Organization ID:</strong> <code>${result.organizationId}</code></li>
      <li><strong>Organization Name:</strong> ${result.organizationName}</li>
      <li><strong>App ID:</strong> ${result.appId}</li>
      <li><strong>App Name:</strong> ${result.appName}</li>
    </ul>

    <p><small>You can close this window.</small></p>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Handle /oauth/authorize - redirect to Linear OAuth flow
 */
export async function handleAuthorize(
  request: Request,
  config: OAuthConfig,
  kv: KeyValueStore,
): Promise<Response> {
  // Generate CSRF state token
  const state = crypto.randomUUID();

  // Store state in KV with 5-minute TTL for CSRF protection
  await kv.put(`oauth:state:${state}`, "pending", { expirationTtl: 300 });

  // Generate callback URL from config baseUrl or request origin
  const baseUrl = config.baseUrl ?? new URL(request.url).origin;
  const callbackUrl = `${baseUrl}/api/oauth/callback`;

  // Generate auth URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(","),
    state,
    actor: "app", // Authenticate as app, not user
  });

  const authUrl = `${LINEAR_OAUTH_URL}?${params.toString()}`;
  const log = Log.create({ service: "oauth" });
  log.info("Redirecting to Linear OAuth", { state });

  return Response.redirect(authUrl, 302);
}

/**
 * Handle /oauth/callback - exchange code for token and store
 */
export async function handleCallback(
  request: Request,
  config: OAuthConfig,
  kv: KeyValueStore,
  tokenStore: TokenStore,
): Promise<Response> {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    const log = Log.create({ service: "oauth" });
    log.error("OAuth error from Linear", { error, errorDescription });
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
    const baseUrl = config.baseUrl ?? url.origin;
    const callbackUrl = `${baseUrl}/api/oauth/callback`;
    const tokenData = await exchangeCodeForToken(code, config, callbackUrl);

    // Get organization info
    const client = new LinearClient({ accessToken: tokenData.accessToken });
    const viewer = await client.viewer;
    const organization = await viewer.organization;

    const log = Log.create({ service: "oauth" })
      .tag("org", organization.name)
      .tag("organizationId", organization.id);

    log.info("Retrieved app info", {
      viewerName: viewer.name,
      viewerId: viewer.id,
    });

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

    log.info("Tokens stored successfully");

    // Return success page
    const result: OAuthCallbackResult = {
      organizationId: organization.id,
      organizationName: organization.name,
      appId: viewer.id,
      appName: viewer.name,
      webhookUrl: `${baseUrl}/api/webhook/linear`,
    };

    return new Response(generateSuccessHtml(result), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    const log = Log.create({ service: "oauth" });
    log.error("OAuth callback failed", {
      error: errorMessage,
      stack: errorStack,
    });
    return new Response(`OAuth setup failed: ${errorMessage}`, { status: 500 });
  }
}

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  tokenStore: TokenStore,
  organizationId: string,
): Promise<string> {
  const log = Log.create({ service: "oauth" }).tag(
    "organizationId",
    organizationId,
  );

  log.info("Refreshing access token");

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
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshData.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("Token refresh failed", {
      status: response.status,
      response: text,
    });
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await parseTokenResponse(response);

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

  log.info("Token refreshed successfully");
  return data.access_token;
}
