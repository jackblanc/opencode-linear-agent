/**
 * Base64 URL-safe encoding utilities
 *
 * Used to encode directory paths for OpenCode session URLs.
 * The format matches OpenCode's web UI routing: /{base64_encoded_dir}/session/{sessionId}
 */

/**
 * Encode a string to URL-safe base64
 *
 * Uses Base64 URL-safe encoding:
 * - '+' is replaced with '-'
 * - '/' is replaced with '_'
 * - Padding '=' is removed
 */
export function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
