/**
 * Storage interfaces - platform agnostic abstractions for persistence
 */

/**
 * Generic key-value store interface
 */
export interface KeyValueStore {
  /**
   * Get a value by key
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Get a value as a string
   */
  getString(key: string): Promise<string | null>;

  /**
   * Put a value
   */
  put(
    key: string,
    value: unknown,
    options?: { expirationTtl?: number },
  ): Promise<void>;

  /**
   * Delete a key
   */
  delete(key: string): Promise<void>;
}

/**
 * Refresh token storage structure
 */
export interface RefreshTokenData {
  refreshToken: string;
  appId: string;
  organizationId: string;
  installedAt: string;
  workspaceName?: string;
}

/**
 * Token store for OAuth tokens
 */
export interface TokenStore {
  /**
   * Get access token for an organization
   */
  getAccessToken(organizationId: string): Promise<string | null>;

  /**
   * Set access token for an organization
   */
  setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void>;

  /**
   * Get refresh token data for an organization
   */
  getRefreshTokenData(organizationId: string): Promise<RefreshTokenData | null>;

  /**
   * Set refresh token data for an organization
   */
  setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void>;
}
