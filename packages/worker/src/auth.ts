/**
 * Authentication helpers for protecting routes
 */

const AUTH_COOKIE_NAME = "opencode_auth";
const AUTH_TOKEN_PAYLOAD = "opencode:authenticated";

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Always compares full length of expected value.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const lengthsMatch = a.length === b.length;
  // Use 'a' for comparison if lengths differ to maintain constant time
  const compareTo = lengthsMatch ? b : a;

  let result = lengthsMatch ? 0 : 1;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ compareTo.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Create HMAC-SHA256 signature of a payload using the API key as secret.
 * Returns hex-encoded signature.
 */
async function createSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validate authentication against ADMIN_API_KEY
 *
 * Supports multiple auth methods:
 * 1. Basic Auth header (username ignored, password = API key)
 * 2. Signed auth cookie (for WebSocket connections)
 *
 * WebSocket connections cannot send custom Authorization headers, but they
 * DO send cookies. So we set a signed auth cookie on successful Basic Auth,
 * which is then used for WebSocket upgrade requests.
 *
 * The cookie contains an HMAC signature (not the raw API key), so even if
 * the cookie value is exposed, it cannot be used to recover the API key.
 */
export async function validateAuth(
  request: Request,
  env: Env,
): Promise<boolean> {
  if (!env.ADMIN_API_KEY) {
    return false;
  }

  // Method 1: Check Basic Auth header
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      // Decode base64: "username:password"
      const decoded = atob(auth.slice(6));
      // Extract password (handle case where password contains ":")
      const password = decoded.split(":").slice(1).join(":");

      if (timingSafeEqual(password, env.ADMIN_API_KEY)) {
        return true;
      }
    } catch {
      // Invalid base64, fall through to cookie check
    }
  }

  // Method 2: Check signed auth cookie (for WebSocket connections)
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader) {
    const cookieToken = getCookie(cookieHeader, AUTH_COOKIE_NAME);
    if (cookieToken) {
      const expectedToken = await createSignature(
        AUTH_TOKEN_PAYLOAD,
        env.ADMIN_API_KEY,
      );
      if (timingSafeEqual(cookieToken, expectedToken)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parse a specific cookie from the Cookie header
 */
function getCookie(cookieHeader: string, name: string): string | null {
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [cookieName, ...valueParts] = cookie.split("=");
    if (cookieName === name) {
      return valueParts.join("=");
    }
  }
  return null;
}

/**
 * Create Set-Cookie header value for signed auth cookie.
 * The cookie contains an HMAC signature proving the user authenticated,
 * rather than the raw API key.
 */
export async function createAuthCookie(apiKey: string): Promise<string> {
  const token = await createSignature(AUTH_TOKEN_PAYLOAD, apiKey);
  // HttpOnly: prevents JS access (XSS protection)
  // Secure: only sent over HTTPS (except localhost)
  // SameSite=Strict: only sent for same-site requests (CSRF protection)
  // Path=/: available for all routes
  return `${AUTH_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
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
