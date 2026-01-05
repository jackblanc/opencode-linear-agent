/**
 * OAuth token refresh for the Agent worker
 */

import type {
  TokenStore,
  RefreshTokenData,
} from "@linear-opencode-agent/infrastructure";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const ACCESS_TOKEN_TTL_SECONDS = 23 * 60 * 60;

interface OAuthEnv {
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
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
