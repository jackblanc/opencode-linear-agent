/**
 * API key validation for protecting OpenCode UI and admin endpoints
 */

/**
 * Validate API key from query parameter
 */
export function validateApiKey(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key || !env.ADMIN_API_KEY) {
    return false;
  }

  return key === env.ADMIN_API_KEY;
}

/**
 * Return 401 unauthorized response
 */
export function unauthorizedResponse(): Response {
  return Response.json(
    { error: "Unauthorized. Provide API key via ?key= query parameter." },
    { status: 401 },
  );
}
