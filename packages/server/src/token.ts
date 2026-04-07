import type { AuthRepository } from "@opencode-linear-agent/core";

import { z } from "zod";

export const tokenExchangeResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(
  authRepository: AuthRepository,
  oauthConfig: { clientId: string; clientSecret: string },
  organizationId: string,
): Promise<string> {
  const refreshData = await authRepository.getRefreshTokenData(organizationId);
  if (!refreshData) {
    throw new Error(
      `No refresh token found for organization ${organizationId}. Please re-authorize.`,
    );
  }

  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      refresh_token: refreshData.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const tokenResult = tokenExchangeResponseSchema.safeParse(await response.json());
  if (!tokenResult.success) {
    throw new Error(`Invalid token response from Linear: ${tokenResult.error.message}`);
  }

  const auth = await authRepository.getAuthRecord(organizationId);
  if (!auth) {
    throw new Error(
      `No auth record found for organization ${organizationId}. Please re-authorize.`,
    );
  }

  await authRepository.putAuthRecord({
    ...auth,
    accessToken: tokenResult.data.access_token,
    accessTokenExpiresAt: tokenResult.data.expires_in * 1000 + Date.now(),
    refreshToken: tokenResult.data.refresh_token,
  });
  return tokenResult.data.access_token;
}
