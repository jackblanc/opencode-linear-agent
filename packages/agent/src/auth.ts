/**
 * Authentication helpers for UI Proxy
 */

const AUTH_COOKIE_NAME = "opencode_auth";
const AUTH_TOKEN_PAYLOAD = "opencode:authenticated";

/**
 * Timing-safe string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  const lengthsMatch = a.length === b.length;
  const compareTo = lengthsMatch ? b : a;

  let result = lengthsMatch ? 0 : 1;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ compareTo.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Create HMAC-SHA256 signature
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
 * Parse a cookie from the Cookie header
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
 * Validate authentication
 *
 * Supports:
 * 1. Basic Auth header
 * 2. Signed auth cookie (for WebSocket connections)
 */
export async function validateAuth(
  request: Request,
  adminApiKey: string,
): Promise<boolean> {
  if (!adminApiKey) {
    return false;
  }

  // Method 1: Check Basic Auth header
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const password = decoded.split(":").slice(1).join(":");

      if (timingSafeEqual(password, adminApiKey)) {
        return true;
      }
    } catch {
      // Invalid base64
    }
  }

  // Method 2: Check signed auth cookie
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader) {
    const cookieToken = getCookie(cookieHeader, AUTH_COOKIE_NAME);
    if (cookieToken) {
      const expectedToken = await createSignature(
        AUTH_TOKEN_PAYLOAD,
        adminApiKey,
      );
      if (timingSafeEqual(cookieToken, expectedToken)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create Set-Cookie header value for signed auth cookie
 */
export async function createAuthCookie(apiKey: string): Promise<string> {
  const token = await createSignature(AUTH_TOKEN_PAYLOAD, apiKey);
  return `${AUTH_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

/**
 * Return 401 unauthorized response
 */
export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="OpenCode"',
    },
  });
}
