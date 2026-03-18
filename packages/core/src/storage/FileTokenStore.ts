/**
 * File-based implementation of TokenStore
 *
 * Wraps FileStore for token-specific operations.
 */

import type { KeyValueStore, RefreshTokenData, TokenStore } from "./types";

/**
 * Key prefixes for token storage
 */
const ACCESS_TOKEN_PREFIX = "token:access:";
const REFRESH_TOKEN_PREFIX = "token:refresh:";

/**
 * File-based TokenStore implementation
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly kv: KeyValueStore) {}

  async getAccessToken(organizationId: string): Promise<string | null> {
    return this.kv.getString(`${ACCESS_TOKEN_PREFIX}${organizationId}`);
  }

  async setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void> {
    await this.kv.put(`${ACCESS_TOKEN_PREFIX}${organizationId}`, token, {
      expirationTtl,
    });
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<RefreshTokenData | null> {
    return this.kv.get<RefreshTokenData>(
      `${REFRESH_TOKEN_PREFIX}${organizationId}`,
    );
  }

  async setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void> {
    // Refresh tokens don't expire
    await this.kv.put(`${REFRESH_TOKEN_PREFIX}${organizationId}`, data);
  }
}
