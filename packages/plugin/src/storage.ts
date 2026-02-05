/**
 * File-based storage for sharing state between plugin and server.
 *
 * Uses the same JSON file format as the server's FileStore.
 * Implements file locking to prevent race conditions during concurrent writes.
 *
 * The store path follows XDG Base Directory specification:
 * ~/.local/share/linear-opencode-agent/store.json
 */

import { open, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseStoreData,
  type StoreData,
  type PendingPermission,
  type PendingQuestion,
  type SessionState,
} from "@linear-opencode-agent/core";

/**
 * XDG-compliant path to the shared store file.
 * Both Docker (via bind mount) and host use the same path.
 * Can be overridden in tests via setStorePath().
 */
let storePath = join(
  homedir(),
  ".local/share/linear-opencode-agent/store.json",
);

export function setStorePath(path: string): void {
  storePath = path;
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

/**
 * Stored session state shared with the server
 */
type StoredSession = SessionState;

/**
 * Session context used by the plugin
 */
export interface SessionContext {
  opencodeSessionId: string;
  linear: {
    sessionId: string;
    issueId: string;
    organizationId: string;
    workdir: string;
  };
}

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

/**
 * Write JSON data to the shared store file (assumes lock is held)
 */
async function writeStore(filePath: string, data: StoreData): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash > 0) {
    const dir = filePath.slice(0, lastSlash);
    await mkdir(dir, { recursive: true });
  }
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
  const data = await readStore(storePath);
  return getValue<string>(data, `${ACCESS_TOKEN_PREFIX}${organizationId}`);
}

/**
 * Read the first available OAuth access token from the store.
 * Scans all token:access:* keys and returns the first non-expired token.
 */
export async function readAnyAccessToken(): Promise<string | null> {
  const data = await readStore(storePath);
  for (const key of Object.keys(data)) {
    if (key.startsWith(ACCESS_TOKEN_PREFIX)) {
      const token = getValue<string>(data, key);
      if (token) return token;
    }
  }
  return null;
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
export async function getSessionAsync(
  opencodeSessionId: string,
): Promise<SessionContext | null> {
  const stored = await readSessionByOpencodeId(opencodeSessionId);
  if (!stored) return null;

  const tokenInfo = await readAnyAccessTokenWithOrg();
  if (!tokenInfo) return null;

  return {
    opencodeSessionId,
    linear: {
      sessionId: stored.linearSessionId,
      issueId: stored.issueId,
      organizationId: tokenInfo.organizationId,
      workdir: stored.workdir,
    },
  };
}

/**
 * Read session state from the shared store file by OpenCode session ID.
 * Scans all session:* keys to find a match.
 */
async function readSessionByOpencodeId(
  opencodeSessionId: string,
): Promise<StoredSession | null> {
  const data = await readStore(storePath);
  for (const key of Object.keys(data)) {
    if (key.startsWith(SESSION_PREFIX)) {
      const session = getValue<StoredSession>(data, key);
      if (session?.opencodeSessionId === opencodeSessionId) {
        return session;
      }
    }
  }
  return null;
}
