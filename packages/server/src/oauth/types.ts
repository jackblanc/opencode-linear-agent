/**
 * OAuth types for Linear authentication
 */

/**
 * OAuth configuration
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Base URL for callbacks (e.g., https://example.com). If not provided, uses request origin. */
  baseUrl?: string;
}

/**
 * Result of OAuth callback containing organization info
 */
export interface OAuthCallbackResult {
  organizationId: string;
  organizationName: string;
  appId: string;
  appName: string;
  webhookUrl: string;
}
