/**
 * Linear OAuth utilities package.
 *
 * Provides OAuth 2.0 authentication for Linear with:
 * - Token exchange and refresh
 * - Local callback server (for CLI tools)
 * - Type-safe error handling with better-result
 * - Zod validation for API responses
 */

// Errors
export {
  MissingCredentialsError,
  TokenExchangeError,
  TokenRefreshError,
  NotAuthenticatedError,
  OAuthCallbackError,
  InvalidResponseError,
  type LinearAuthError,
} from "./errors";

// Token operations
export {
  exchangeCodeForTokens,
  refreshAccessToken,
  getOAuthCredentials,
  type TokenResponse,
  type OAuthCredentials,
} from "./tokens";

// Local OAuth server (Bun only)
export {
  generateState,
  startServer,
  stopServer,
  waitForCallback,
  getRedirectUri,
  DEFAULT_PORT,
  CALLBACK_PATH,
} from "./server";

// Client utilities
export {
  createFileStorage,
  getValidAccessToken,
  createLinearClient,
  isAuthenticated,
  type LinearAuth,
  type AuthStorage,
} from "./client";
