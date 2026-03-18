import { Result } from "better-result";
import type { z } from "zod";

import { KvJsonParseError, KvSchemaError, type KvError } from "./errors";

export function parseJson<T>(
  text: string,
  path: string,
  schema: z.ZodType<T>,
): Result<T, KvError> {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (error) {
    return Result.err(
      new KvJsonParseError({
        path,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return Result.err(
      new KvSchemaError({
        path,
        issues: parsed.error.issues.map((issue) => issue.message),
      }),
    );
  }

  return Result.ok(parsed.data);
}

export function stringifyJson<T>(
  value: T,
  path: string,
): Result<string, KvError> {
  try {
    return Result.ok(`${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    return Result.err(
      new KvJsonParseError({
        path,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
