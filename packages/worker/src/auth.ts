/**
 * Authentication helpers for protecting routes
 */

/**
 * Validate Basic Auth header against ADMIN_API_KEY
 * Username is ignored, only password is validated
 */
export function validateBasicAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");

  if (!auth?.startsWith("Basic ") || !env.ADMIN_API_KEY) {
    return false;
  }

  try {
    // Decode base64: "username:password"
    const decoded = atob(auth.slice(6));
    // Extract password (handle case where password contains ":")
    const password = decoded.split(":").slice(1).join(":");

    return password === env.ADMIN_API_KEY;
  } catch {
    return false;
  }
}

/**
 * Return 401 unauthorized response with Basic Auth challenge
 */
export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="OpenCode"',
    },
  });
}
