/**
 * Zod schemas for runtime validation of our custom types.
 *
 * These schemas validate data at runtime boundaries (JSON parsing, external APIs)
 * to provide clear error messages and type safety.
 *
 * Note: Linear SDK types are NOT validated here - they are guaranteed by Linear's SDK.
 */

import { z } from "zod";

/**
 * Schema for OAuth token response from Linear
 */
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * Parse token response from unknown JSON with user-friendly error messages
 */
export function parseTokenResponse(data: unknown): TokenResponse {
  const result = TokenResponseSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid token response from Linear:\n${issues}`);
  }
  return result.data;
}
