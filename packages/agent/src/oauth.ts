/**
 * OAuth token refresh for the Agent worker
 *
 * Thin wrapper around the core refreshAccessToken function.
 */

import {
  refreshAccessToken as coreRefreshAccessToken,
  type TokenStore,
} from "@linear-opencode-agent/core";

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
  return coreRefreshAccessToken(
    {
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    },
    tokenStore,
    organizationId,
  );
}
