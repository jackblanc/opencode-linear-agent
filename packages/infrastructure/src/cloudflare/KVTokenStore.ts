import type { TokenStore, RefreshTokenData, KeyValueStore } from "../types";

/**
 * KV-backed implementation of TokenStore
 */
export class KVTokenStore implements TokenStore {
  private readonly accessPrefix = "token:access:";
  private readonly refreshPrefix = "token:refresh:";

  constructor(private readonly kv: KeyValueStore) {}

  async getAccessToken(organizationId: string): Promise<string | null> {
    return this.kv.getString(`${this.accessPrefix}${organizationId}`);
  }

  async setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void> {
    await this.kv.put(`${this.accessPrefix}${organizationId}`, token, {
      expirationTtl,
    });
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<RefreshTokenData | null> {
    return this.kv.get<RefreshTokenData>(
      `${this.refreshPrefix}${organizationId}`,
    );
  }

  async setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void> {
    await this.kv.put(`${this.refreshPrefix}${organizationId}`, data);
  }
}
