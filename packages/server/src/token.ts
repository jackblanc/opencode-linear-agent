import type { AuthRepository, AuthRepositoryError } from "@opencode-linear-agent/core";
import type { Result as ResultType } from "better-result";

import { AuthAccessTokenExpiredError, KvNotFoundError } from "@opencode-linear-agent/core";
import { Result, TaggedError } from "better-result";
import { z } from "zod";

class TokenRefreshNotFoundError extends TaggedError("TokenRefreshNotFoundError")<{
  message: string;
  organizationId: string;
}>() {
  constructor(args: { organizationId: string }) {
    super({
      organizationId: args.organizationId,
      message: `No refresh token found for organization ${args.organizationId}. Please re-authorize.`,
    });
  }
}

class TokenRefreshExchangeError extends TaggedError("TokenRefreshExchangeError")<{
  message: string;
  status: number;
}>() {
  constructor(args: { status: number }) {
    super({
      status: args.status,
      message: `Token refresh failed: ${args.status}`,
    });
  }
}

class TokenRefreshResponseError extends TaggedError("TokenRefreshResponseError")<{
  message: string;
  reason: string;
}>() {
  constructor(args: { reason: string }) {
    super({
      reason: args.reason,
      message: `Invalid token response from Linear: ${args.reason}`,
    });
  }
}

class TokenRefreshIoError extends TaggedError("TokenRefreshIoError")<{
  message: string;
  reason: string;
}>() {
  constructor(args: { reason: string }) {
    super({
      reason: args.reason,
      message: `Token refresh request failed: ${args.reason}`,
    });
  }
}

export const tokenExchangeResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

type TokenRefreshError =
  | AuthRepositoryError
  | TokenRefreshNotFoundError
  | TokenRefreshExchangeError
  | TokenRefreshResponseError
  | TokenRefreshIoError;

export async function getLinearAccessToken(
  authRepository: AuthRepository,
  oauthConfig: { clientId: string; clientSecret: string },
  organizationId: string,
): Promise<ResultType<string, TokenRefreshError>> {
  const accessToken = await authRepository.getAccessToken(organizationId);
  if (accessToken.isOk()) {
    return Result.ok(accessToken.value);
  }
  if (!AuthAccessTokenExpiredError.is(accessToken.error)) {
    return Result.err(accessToken.error);
  }

  return refreshAccessToken(authRepository, oauthConfig, organizationId);
}

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(
  authRepository: AuthRepository,
  oauthConfig: { clientId: string; clientSecret: string },
  organizationId: string,
): Promise<ResultType<string, TokenRefreshError>> {
  return Result.gen(async function* () {
    const refreshData = await authRepository.getRefreshTokenData(organizationId);
    if (refreshData.isErr()) {
      return KvNotFoundError.is(refreshData.error)
        ? Result.err(new TokenRefreshNotFoundError({ organizationId }))
        : Result.err(refreshData.error);
    }

    const response = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          fetch("https://api.linear.app/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: oauthConfig.clientId,
              client_secret: oauthConfig.clientSecret,
              refresh_token: refreshData.value.refreshToken,
            }),
          }),
        catch: (cause: unknown) =>
          new TokenRefreshIoError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    );
    if (!response.ok) {
      return Result.err(new TokenRefreshExchangeError({ status: response.status }));
    }

    const json = yield* Result.await(
      Result.tryPromise({
        try: async () => response.json(),
        catch: (cause: unknown) =>
          new TokenRefreshIoError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    );

    const tokenResult = tokenExchangeResponseSchema.safeParse(json);
    if (!tokenResult.success) {
      return Result.err(new TokenRefreshResponseError({ reason: tokenResult.error.message }));
    }

    const auth = await authRepository.getAuthRecord(organizationId);
    if (auth.isErr()) {
      return KvNotFoundError.is(auth.error)
        ? Result.err(new TokenRefreshNotFoundError({ organizationId }))
        : Result.err(auth.error);
    }

    yield* Result.await(
      authRepository.putAuthRecord({
        ...auth.value,
        accessToken: tokenResult.data.access_token,
        accessTokenExpiresAt: tokenResult.data.expires_in * 1000 + Date.now(),
        refreshToken: tokenResult.data.refresh_token,
      }),
    );

    return Result.ok(tokenResult.data.access_token);
  });
}
