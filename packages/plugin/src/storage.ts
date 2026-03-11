/**
 * File-based storage for sharing state between plugin and server.
 *
 * Uses the same JSON file format as the server's FileStore.
 * Implements file locking to prevent race conditions during concurrent writes.
 *
 * The store path follows the shared XDG helper.
 */

import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Result } from "better-result";
import {
  getStorePath,
  parseStoreData,
  type StoreData,
  type PendingQuestion,
  type PendingPermission,
} from "@opencode-linear-agent/core";
export interface LinearContext {
  sessionId: string | null;
  issueId: string;
  organizationId: string;
  workdir: string;
}

let storePath = getStorePath();

export function setStorePath(path: string): void {
  storePath = path;
}

type StoreReadErrorKind = "parse_error" | "schema_error" | "io_error";

export interface StoreReadError {
  kind: StoreReadErrorKind;
  path: string;
  message: string;
}

/**
 * Key prefixes matching the server's storage format
 */
const ACCESS_TOKEN_PREFIX = "token:access:";
const PENDING_QUESTION_PREFIX = "question:";
const PENDING_PERMISSION_PREFIX = "permission:";
const SESSION_PREFIX = "session:";

/**
 * Lock configuration
 */
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_DELAY_MS = 50;

/**
 * Acquire a file lock using exclusive file creation.
 * Returns a release function to call when done.
 */
async function acquireLock(
  filePath: string,
): Promise<{ release: () => Promise<void> }> {
  const lockPath = `${filePath}.lock`;
  const startTime = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.write(String(Date.now()));
      await handle.close();

      return {
        release: async () => {
          const { unlink } = await import("node:fs/promises");
          await unlink(lockPath).catch(() => {});
        },
      };
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "EEXIST") {
        if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
          const { unlink } = await import("node:fs/promises");
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, LOCK_RETRY_DELAY_MS),
        );
        continue;
      }
      throw err;
    }
  }
}

/**
 * Execute a function with file locking
 */
async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(filePath);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export type { PendingQuestion, PendingPermission };

/**
 * Read JSON data from the shared store file (no locking - for read-only operations)
 */
async function readStore(filePath: string): Promise<StoreData> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {};
  }
  const json: unknown = await file.json();
  return parseStoreData(json);
}

function toStoreReadError(error: unknown, filePath: string): StoreReadError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Invalid store data:")) {
    return {
      kind: "schema_error",
      path: filePath,
      message,
    };
  }
  if (error instanceof SyntaxError || message.includes("parse JSON")) {
    return {
      kind: "parse_error",
      path: filePath,
      message,
    };
  }
  return {
    kind: "io_error",
    path: filePath,
    message,
  };
}

export function formatStoreReadError(error: StoreReadError): string {
  const reason =
    error.kind === "parse_error"
      ? "invalid JSON"
      : error.kind === "schema_error"
        ? "invalid store schema"
        : "store read failure";
  return [
    `Linear store read failed (${reason}) at ${error.path}.`,
    `Cause: ${error.message}`,
    "Recovery: 1) Fix or restore store.json, 2) restart agent server, 3) re-run Linear auth if token data was lost.",
  ].join(" ");
}

async function readStoreSafe(
  filePath: string,
): Promise<Result<StoreData, StoreReadError>> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return Result.ok({});
  }

  return Result.tryPromise({
    try: async () => {
      const json: unknown = await file.json();
      return parseStoreData(json);
    },
    catch: (e) => toStoreReadError(e, filePath),
  });
}

/**
 * Write JSON data to the shared store file (assumes lock is held)
 */
async function writeStore(filePath: string, data: StoreData): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(data, null, 2));
}

/**
 * Atomically read-modify-write the store with file locking
 */
async function modifyStore(
  filePath: string,
  modifier: (data: StoreData) => StoreData,
): Promise<void> {
  await withLock(filePath, async () => {
    const data = await readStore(filePath);
    const modified = modifier(data);
    await writeStore(filePath, modified);
  });
}

/**
 * Get a value from the store, checking expiration
 */
function getValue<T>(data: StoreData, key: string): T | null {
  const stored = data[key];
  if (!stored) return null;
  if (stored.expires && Date.now() > stored.expires) return null;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Generic KV store requires type assertion
  return stored.value as T;
}

/**
 * Read the OAuth access token from the shared store file.
 */
export async function readAccessToken(
  organizationId: string,
): Promise<string | null> {
  const result = await readAccessTokenSafe(organizationId);
  if (Result.isError(result)) {
    return null;
  }
  return result.value;
}

export async function readAccessTokenSafe(
  organizationId: string,
): Promise<Result<string | null, StoreReadError>> {
  const dataResult = await readStoreSafe(storePath);
  if (Result.isError(dataResult)) {
    return Result.err(dataResult.error);
  }
  return Result.ok(
    getValue<string>(
      dataResult.value,
      `${ACCESS_TOKEN_PREFIX}${organizationId}`,
    ),
  );
}

export async function readAnyAccessTokenSafe(): Promise<
  Result<string | null, StoreReadError>
> {
  const dataResult = await readStoreSafe(storePath);
  if (Result.isError(dataResult)) {
    return Result.err(dataResult.error);
  }
  for (const key of Object.keys(dataResult.value)) {
    if (key.startsWith(ACCESS_TOKEN_PREFIX)) {
      const token = getValue<string>(dataResult.value, key);
      if (token) return Result.ok(token);
    }
  }
  return Result.ok(null);
}

/**
 * Read the first available OAuth access token and its organization ID from the store.
 * Returns both so caller can initialize session context properly.
 */
async function readAnyAccessTokenWithOrg(): Promise<{
  token: string;
  organizationId: string;
} | null> {
  const data = await readStore(storePath);
  for (const key of Object.keys(data)) {
    if (key.startsWith(ACCESS_TOKEN_PREFIX)) {
      const token = getValue<string>(data, key);
      if (token) {
        const organizationId = key.slice(ACCESS_TOKEN_PREFIX.length);
        return { token, organizationId };
      }
    }
  }
  return null;
}

/**
 * Save a pending question to the shared store file.
 * Uses file locking to prevent concurrent write conflicts.
 */
export async function savePendingQuestion(
  question: PendingQuestion,
): Promise<void> {
  await modifyStore(storePath, (data) => {
    const key = `${PENDING_QUESTION_PREFIX}${question.linearSessionId}`;
    return { ...data, [key]: { value: question } };
  });
}

/**
 * Save a pending permission to the shared store file.
 * Uses file locking to prevent concurrent write conflicts.
 */
export async function savePendingPermission(
  permission: PendingPermission,
): Promise<void> {
  await modifyStore(storePath, (data) => {
    const key = `${PENDING_PERMISSION_PREFIX}${permission.linearSessionId}`;
    return { ...data, [key]: { value: permission } };
  });
}

/**
 * Session state stored by the server
 */
interface StoredSession {
  opencodeSessionId: string;
  linearSessionId: string;
  issueId: string;
  branchName: string;
  workdir: string;
  lastActivityTime: number;
}

/**
 * Read session state from the shared store file by workdir.
 * Scans all session:* keys and returns the most recent match.
 */
async function readSessionByWorkdir(
  workdir: string,
): Promise<StoredSession | null> {
  const data = await readStore(storePath);
  let latest: StoredSession | null = null;

  for (const key of Object.keys(data)) {
    if (key.startsWith(SESSION_PREFIX)) {
      const session = getValue<StoredSession>(data, key);
      if (!session || session.workdir !== workdir) {
        continue;
      }
      if (!latest || session.lastActivityTime > latest.lastActivityTime) {
        latest = session;
      }
    }
  }
  return latest;
}

/**
 * Get session context by workdir from file store.
 * Returns null if session or token not found.
 */
export async function getSessionAsync(
  workdir: string,
): Promise<LinearContext | null> {
  const stored = await readSessionByWorkdir(workdir);
  if (!stored) return null;

  const tokenInfo = await readAnyAccessTokenWithOrg();
  if (!tokenInfo) return null;

  return {
    sessionId: stored.linearSessionId,
    issueId: stored.issueId,
    organizationId: tokenInfo.organizationId,
    workdir: stored.workdir,
  };
}

export async function getSessionAsyncSafe(
  workdir: string,
): Promise<Result<LinearContext | null, StoreReadError>> {
  return Result.tryPromise({
    try: async () => getSessionAsync(workdir),
    catch: (e) => toStoreReadError(e, storePath),
  });
}
