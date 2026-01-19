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
 * Schema for a single stored value in the key-value store
 */
export const StoredValueSchema = z.object({
  value: z.unknown(),
  expires: z.number().optional(),
});

export type StoredValue = z.infer<typeof StoredValueSchema>;

/**
 * Schema for the entire store data (record of stored values)
 */
export const StoreDataSchema = z.record(z.string(), StoredValueSchema);

export type StoreData = z.infer<typeof StoreDataSchema>;

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
 * Parse store data from unknown JSON with user-friendly error messages
 */
export function parseStoreData(data: unknown): StoreData {
  const result = StoreDataSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid store data:\n${issues}`);
  }
  return result.data;
}

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
