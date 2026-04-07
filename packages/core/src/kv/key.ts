import { Result } from "better-result";

import type { KvError } from "./errors";

import { KvInvalidKeyError } from "./errors";

const INVALID_SEGMENT = /[\\/]/u;

export function encodeKvKey(key: string): Result<string, KvError> {
  if (key.length === 0) {
    return Result.err(new KvInvalidKeyError({ key, reason: "key must not be empty" }));
  }

  if (key === "." || key === "..") {
    return Result.err(new KvInvalidKeyError({ key, reason: "reserved path segment" }));
  }

  if (INVALID_SEGMENT.test(key)) {
    return Result.err(new KvInvalidKeyError({ key, reason: "key must be one path segment" }));
  }

  return Result.ok(key);
}
