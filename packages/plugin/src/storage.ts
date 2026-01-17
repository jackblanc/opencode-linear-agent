/**
 * File-based storage for sharing state between plugin and server.
 *
 * Uses the same JSON file format as the server's FileStore.
 * Implements file locking to prevent race conditions during concurrent writes.
 */

import { open, mkdir } from "node:fs/promises";

/**
 * Internal storage structure for a single value
 */
interface StoredValue {
  value: unknown;
  expires?: number;
}

/**
 * Internal storage structure for the entire store
 */
type StoreData = Record<string, StoredValue>;

/**
 * Key prefixes matching the server's storage format
 */
const ACCESS_TOKEN_PREFIX = "token:access:";
const PENDING_QUESTION_PREFIX = "pending:question:";
const PENDING_PERMISSION_PREFIX = "pending:permission:";

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
 * Question option for elicitation
 */
interface QuestionOption {
  label: string;
  description: string;
}

/**
 * A single question from OpenCode's mcp_question tool
 */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

/**
 * Pending question waiting for user response
 */
export interface PendingQuestion {
  requestId: string;
  opcodeSessionId: string;
  linearSessionId: string;
  workdir: string;
  issueId: string;
  questions: QuestionInfo[];
  answers: Array<string[] | null>;
  createdAt: number;
}

/**
 * Pending permission waiting for user approval
 */
export interface PendingPermission {
  requestId: string;
  opcodeSessionId: string;
  linearSessionId: string;
  workdir: string;
  issueId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
}

/**
 * Read JSON data from the shared store file (no locking - for read-only operations)
 */
async function readStore(filePath: string): Promise<StoreData> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {};
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON parse requires type assertion
  const data = (await file.json()) as StoreData;
  return data;
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
  filePath: string,
  organizationId: string,
): Promise<string | null> {
  const data = await readStore(filePath);
  return getValue<string>(data, `${ACCESS_TOKEN_PREFIX}${organizationId}`);
}

/**
 * Save a pending question to the shared store file.
 * Uses file locking to prevent concurrent write conflicts.
 */
export async function savePendingQuestion(
  filePath: string,
  question: PendingQuestion,
): Promise<void> {
  await modifyStore(filePath, (data) => {
    const key = `${PENDING_QUESTION_PREFIX}${question.linearSessionId}`;
    return { ...data, [key]: { value: question } };
  });
}

/**
 * Save a pending permission to the shared store file.
 * Uses file locking to prevent concurrent write conflicts.
 */
export async function savePendingPermission(
  filePath: string,
  permission: PendingPermission,
): Promise<void> {
  await modifyStore(filePath, (data) => {
    const key = `${PENDING_PERMISSION_PREFIX}${permission.linearSessionId}`;
    return { ...data, [key]: { value: permission } };
  });
}
