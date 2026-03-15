/**
 * Shared utilities for Linear tools.
 */

import { LinearClient } from "@linear/sdk";
import { Result } from "better-result";
import { readAnyAccessTokenSafe, formatAuthReadError } from "../storage";

let cachedClient: { token: string; client: LinearClient } | null = null;

export async function getClient(): Promise<Result<LinearClient, string>> {
  const tokenResult = await readAnyAccessTokenSafe();
  if (Result.isError(tokenResult)) {
    return Result.err(formatAuthReadError(tokenResult.error));
  }
  const token = tokenResult.value;
  if (!token) {
    return Result.err(
      "No unique Linear access token found in auth.json. Ensure the agent server has authenticated exactly one org.",
    );
  }
  if (cachedClient && cachedClient.token === token) {
    return Result.ok(cachedClient.client);
  }
  const client = new LinearClient({ accessToken: token });
  cachedClient = { token, client };
  return Result.ok(client);
}

export function resetClientCacheForTest(): void {
  cachedClient = null;
}

export function errorJson(message: string): string {
  return JSON.stringify({ error: message });
}

export function withWarnings(
  data: Record<string, unknown>,
  warnings: string[],
): string {
  return JSON.stringify(warnings.length > 0 ? { ...data, warnings } : data);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * Parse ISO dates and ISO 8601 durations into Date objects.
 * Supports: ISO date strings, -P1D, -P7D, -PT2H30M, P1W, etc.
 */
export function parseDateFilter(value: string): Date {
  if (value.startsWith("-P") || value.startsWith("P")) {
    const neg = value.startsWith("-");
    const dur = neg ? value.slice(1) : value;
    const match = dur.match(
      /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/,
    );
    if (match) {
      const years = parseInt(match[1] ?? "0", 10);
      const months = parseInt(match[2] ?? "0", 10);
      const weeks = parseInt(match[3] ?? "0", 10);
      const days = parseInt(match[4] ?? "0", 10);
      const hours = parseInt(match[5] ?? "0", 10);
      const minutes = parseInt(match[6] ?? "0", 10);
      const ms =
        (years * 31536000 +
          months * 2592000 +
          weeks * 604800 +
          days * 86400 +
          hours * 3600 +
          minutes * 60) *
        1000;
      return new Date(Date.now() - (neg ? ms : -ms));
    }
  }
  return new Date(value);
}
