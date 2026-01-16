/**
 * Linear client factory with automatic token refresh.
 *
 * Note: This module provides a simple file-based token storage for local CLI usage.
 * For server deployments, use the abstract TokenStore interface from @linear-opencode-agent/core.
 */

import { Result } from "better-result";
import { LinearClient } from "@linear/sdk";
import { refreshAccessToken, type OAuthCredentials } from "./tokens";
import {
  NotAuthenticatedError,
  type MissingCredentialsError,
  type TokenRefreshError,
  type InvalidResponseError,
} from "./errors";

// Buffer time before expiration to trigger token refresh (5 minutes)
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface LinearAuth {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface AuthStorage {
  get(): Promise<LinearAuth | null>;
  set(auth: LinearAuth): Promise<void>;
}

/**
 * Create a file-based auth storage (Bun only).
 */
export function createFileStorage(filePath: string): AuthStorage {
  return {
    async get() {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return null;

      const data = await file.json();
      const auth = data?.linear;
      if (!auth || auth.type !== "oauth") return null;

      return auth;
    },
    async set(auth: LinearAuth) {
      const file = Bun.file(filePath);
      let data: Record<string, LinearAuth> = {};

      const exists = await file.exists();
      if (exists) {
        data = await file.json();
      }

      data.linear = auth;
      await Bun.write(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    },
  };
}

/**
 * Get a valid access token, refreshing if necessary.
 */
export async function getValidAccessToken(
  storage: AuthStorage,
  credentials?: OAuthCredentials,
): Promise<
  Result<
    string,
    | NotAuthenticatedError
    | MissingCredentialsError
    | TokenRefreshError
    | InvalidResponseError
  >
> {
  const auth = await storage.get();
  if (!auth) return Result.err(new NotAuthenticatedError());

  if (auth.expires < Date.now() + REFRESH_BUFFER_MS) {
    return (await refreshAccessToken(auth.refresh, credentials)).andThenAsync(
      async (tokens) => {
        await storage.set({
          type: "oauth",
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: Date.now() + tokens.expires_in * 1000,
          accountId: auth.accountId,
        });
        return Result.ok(tokens.access_token);
      },
    );
  }

  return Result.ok(auth.access);
}

/**
 * Create a LinearClient with automatic token refresh.
 */
export async function createLinearClient(
  storage: AuthStorage,
  credentials?: OAuthCredentials,
): Promise<
  Result<
    LinearClient,
    | NotAuthenticatedError
    | MissingCredentialsError
    | TokenRefreshError
    | InvalidResponseError
  >
> {
  return (await getValidAccessToken(storage, credentials)).andThen((token) =>
    Result.ok(new LinearClient({ accessToken: token })),
  );
}

/**
 * Check if Linear is authenticated.
 */
export async function isAuthenticated(storage: AuthStorage): Promise<boolean> {
  const auth = await storage.get();
  return auth !== null;
}
