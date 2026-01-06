/**
 * OAuth handlers for Linear - Cloudflare Workers implementation
 *
 * These are thin wrappers around the core OAuth handlers.
 */

import {
  handleAuthorize as coreHandleAuthorize,
  handleCallback as coreHandleCallback,
  type KeyValueStore,
  type TokenStore,
} from "@linear-opencode-agent/core";

/**
 * Environment bindings required for OAuth
 */
interface OAuthEnv {
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
}

/**
 * Handle /oauth/authorize - redirect to Linear OAuth flow
 */
export async function handleAuthorize(
  request: Request,
  env: OAuthEnv,
  kv: KeyValueStore,
): Promise<Response> {
  return coreHandleAuthorize(
    request,
    {
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    },
    kv,
  );
}

/**
 * Handle /oauth/callback - exchange code for token and store
 */
export async function handleCallback(
  request: Request,
  env: OAuthEnv,
  kv: KeyValueStore,
  tokenStore: TokenStore,
): Promise<Response> {
  return coreHandleCallback(
    request,
    {
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    },
    kv,
    tokenStore,
  );
}
