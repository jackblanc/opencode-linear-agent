import { Result } from "better-result";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import type { KvError } from "../errors";

import { KvIoError, KvLockError } from "../errors";
import { encodeKvKey } from "../key";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 25;

interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

interface HeldLock {
  path: string;
  release: () => Promise<void>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createLock(path: string): Promise<Result<HeldLock, KvError>> {
  return Result.tryPromise({
    try: async () => {
      const handle = await open(path, "wx");
      await handle.writeFile(String(Date.now()), "utf8");
      await handle.close();

      return {
        path,
        release: async () => {
          await rm(path, { force: true });
        },
      };
    },
    catch: (error) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return new KvLockError({ path, reason: "already locked" });
      }

      return new KvIoError({
        path,
        operation: "lock",
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

export async function withFileLock<T>(
  rootPath: string,
  name: string,
  fn: () => Promise<Result<T, KvError>>,
  options?: FileLockOptions,
): Promise<Result<T, KvError>> {
  const key = encodeKvKey(name);
  if (Result.isError(key)) {
    return Result.err(key.error);
  }

  const lockRoot = join(rootPath, ".locks");
  const lockPath = join(lockRoot, `${key.value}.lock`);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;

  const dir = await Result.tryPromise({
    try: async () => {
      await mkdir(lockRoot, { recursive: true });
    },
    catch: (error) =>
      new KvIoError({
        path: lockRoot,
        operation: "mkdir",
        reason: error instanceof Error ? error.message : String(error),
      }),
  });
  if (Result.isError(dir)) {
    return Result.err(dir.error);
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const lock = await createLock(lockPath);
    if (Result.isOk(lock)) {
      try {
        return await fn();
      } catch (error) {
        return Result.err(
          new KvIoError({
            path: lockPath,
            operation: "lock-operation",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        await lock.value.release();
      }
    }

    if (lock.error._tag !== "KvLockError") {
      return Result.err(lock.error);
    }

    await sleep(retryMs);
  }

  return Result.err(new KvLockError({ path: lockPath, reason: `timeout after ${timeoutMs}ms` }));
}
