/**
 * Storage interfaces - platform agnostic abstractions for persistence
 */

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

export interface AuthRecord {
  organizationId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  appId: string;
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
   * Get refresh token data for an organization
   */
  getRefreshTokenData(organizationId: string): Promise<RefreshTokenData | null>;

  /**
   * Get full auth record for an organization
   */
  getAuthRecord(organizationId: string): Promise<AuthRecord | null>;

  /**
   * Put full auth record for an organization
   */
  putAuthRecord(record: AuthRecord): Promise<void>;
}
