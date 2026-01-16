/**
 * Token exchange and refresh logic for Linear OAuth.
 */

import { z } from "zod";
import { Result } from "better-result";
import {
  MissingCredentialsError,
  TokenExchangeError,
  TokenRefreshError,
  InvalidResponseError,
} from "./errors";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
  scope: z.string().optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get OAuth credentials from environment variables.
 */
export function getOAuthCredentials(): Result<
  OAuthCredentials,
  MissingCredentialsError
> {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return Result.err(new MissingCredentialsError());
  }

  return Result.ok({ clientId, clientSecret });
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  credentials?: OAuthCredentials,
): Promise<
  Result<
    TokenResponse,
    MissingCredentialsError | TokenExchangeError | InvalidResponseError
  >
> {
  const creds = credentials ? Result.ok(credentials) : getOAuthCredentials();

  return creds.andThenAsync(async (c: OAuthCredentials) => {
    const response = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!response.ok) {
      return Result.err(new TokenExchangeError(response.status));
    }

    const parsed = TokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return Result.err(new InvalidResponseError(parsed.error));
    }

    return Result.ok(parsed.data);
  });
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  credentials?: OAuthCredentials,
): Promise<
  Result<
    TokenResponse,
    MissingCredentialsError | TokenRefreshError | InvalidResponseError
  >
> {
  const creds = credentials ? Result.ok(credentials) : getOAuthCredentials();

  return creds.andThenAsync(async (c: OAuthCredentials) => {
    const response = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      return Result.err(new TokenRefreshError(response.status));
    }

    const parsed = TokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return Result.err(new InvalidResponseError(parsed.error));
    }

    return Result.ok(parsed.data);
  });
}
