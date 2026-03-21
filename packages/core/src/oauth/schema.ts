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
