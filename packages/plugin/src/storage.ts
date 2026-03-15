/**
 * File-based storage for sharing state between plugin and server.
 *
 * Uses `store.json` for session/pending state and `auth.json` for OAuth state.
 * Implements file locking to prevent race conditions during concurrent writes.
 *
 * The file paths follow the shared XDG helpers.
 */

import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Result } from "better-result";
import {
  getAuthPath,
  getStorePath,
  parseAuthData,
  parseStoreData,
  type AuthData,
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

let storePath: string | null = null;
let authPath: string | null = null;

function getEffectiveStorePath(): string {
  if (storePath) {
    return storePath;
  }
  const path = getStorePath();
  storePath = path;
  return path;
}

export function setStorePath(path: string): void {
  storePath = path;
}

function getEffectiveAuthPath(): string {
  if (authPath) {
    return authPath;
  }
  const path = getAuthPath();
  authPath = path;
  return path;
}

export function setAuthPath(path: string): void {
  authPath = path;
}

type StoreReadErrorKind = "parse_error" | "schema_error" | "io_error";

interface BaseReadError {
  kind: StoreReadErrorKind;
  path: string;
  message: string;
}

export interface StoreReadError extends BaseReadError {
  fileType: "store";
}

export interface AuthReadError extends BaseReadError {
  fileType: "auth";
}

/**
 * Key prefixes matching the server's store format
 */
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

function toStoreReadError(error: unknown, filePath: string): StoreReadError {
  return toReadError(error, filePath, "store");
}

function toAuthReadError(error: unknown, filePath: string): AuthReadError {
  return toReadError(error, filePath, "auth");
}

function toReadError(
  error: unknown,
  filePath: string,
  fileType: "store",
): StoreReadError;
function toReadError(
  error: unknown,
  filePath: string,
  fileType: "auth",
): AuthReadError;
function toReadError(
  error: unknown,
  filePath: string,
  fileType: "store" | "auth",
): StoreReadError | AuthReadError {
  const message = error instanceof Error ? error.message : String(error);
  const schemaPrefix =
    fileType === "store" ? "Invalid store data:" : "Invalid auth data:";
  if (message.startsWith(schemaPrefix)) {
    return {
      kind: "schema_error",
      path: filePath,
      message,
      fileType,
    };
  }
  if (error instanceof SyntaxError || message.includes("parse JSON")) {
    return {
      kind: "parse_error",
      path: filePath,
      message,
      fileType,
    };
  }
  return {
    kind: "io_error",
    path: filePath,
    message,
    fileType,
  };
}

export function formatStoreReadError(error: StoreReadError): string {
  return formatReadError(error);
}

export function formatAuthReadError(error: AuthReadError): string {
  return formatReadError(error);
}

function formatReadError(error: StoreReadError | AuthReadError): string {
  const reason =
    error.kind === "parse_error"
      ? "invalid JSON"
      : error.kind === "schema_error"
        ? `invalid ${error.fileType} schema`
        : `${error.fileType} read failure`;
  const fileLabel = error.fileType === "auth" ? "Linear auth" : "Linear store";
  const recovery =
    error.fileType === "auth"
      ? "Recovery: 1) Fix or restore auth.json, 2) restart agent server, 3) re-run Linear auth if token data was lost."
      : "Recovery: 1) Fix or restore store.json, 2) restart agent server, 3) retry the action after session state is healthy.";
  return [
    `${fileLabel} read failed (${reason}) at ${error.path}.`,
    `Cause: ${error.message}`,
    recovery,
  ].join(" ");
}

async function readAuthSafe(
  filePath: string,
): Promise<Result<AuthData, AuthReadError>> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return Result.ok({
      version: 1,
      organizations: {},
    });
  }

  return Result.tryPromise({
    try: async () => {
      const json: unknown = await file.json();
      return parseAuthData(json);
    },
    catch: (e) => toAuthReadError(e, filePath),
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

function getAuthAccessToken(
  data: AuthData,
  organizationId: string,
): string | null {
  const accessToken = data.organizations[organizationId]?.accessToken;
  if (!accessToken) {
    return null;
  }
  if (Date.now() > accessToken.expiresAt) {
    return null;
  }
  return accessToken.value;
}

type AccessTokenSelection =
  | { kind: "missing" }
  | { kind: "found"; token: string; organizationId: string };

function selectAnyAccessToken(data: AuthData): AccessTokenSelection {
  for (const organizationId of Object.keys(data.organizations)) {
    const token = getAuthAccessToken(data, organizationId);
    if (token) {
      return { kind: "found", token, organizationId };
    }
  }
  return { kind: "missing" };
}

/**
 * Read the OAuth access token from auth.json.
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
): Promise<Result<string | null, AuthReadError>> {
  const path = getEffectiveAuthPath();
  const dataResult = await readAuthSafe(path);
  if (Result.isError(dataResult)) {
    return Result.err(dataResult.error);
  }
  return Result.ok(getAuthAccessToken(dataResult.value, organizationId));
}

export async function readAnyAccessTokenSafe(): Promise<
  Result<string | null, AuthReadError>
> {
  const path = getEffectiveAuthPath();
  const dataResult = await readAuthSafe(path);
  if (Result.isError(dataResult)) {
    return Result.err(dataResult.error);
  }
  const selection = selectAnyAccessToken(dataResult.value);
  if (selection.kind !== "found") {
    return Result.ok(null);
  }
  return Result.ok(selection.token);
}

/**
 * Save a pending question to the shared store file.
 * Uses file locking to prevent concurrent write conflicts.
 */
export async function savePendingQuestion(
  question: PendingQuestion,
): Promise<void> {
  await modifyStore(getEffectiveStorePath(), (data) => {
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
  await modifyStore(getEffectiveStorePath(), (data) => {
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
  organizationId: string;
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
  const data = await readStore(getEffectiveStorePath());
  return readSessionByWorkdirFromData(data, workdir);
}

function readSessionByWorkdirFromData(
  data: StoreData,
  workdir: string,
): StoredSession | null {
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

  const token = await readAccessToken(stored.organizationId);
  if (!token) return null;

  return {
    sessionId: stored.linearSessionId,
    issueId: stored.issueId,
    organizationId: stored.organizationId,
    workdir: stored.workdir,
  };
}

export async function getSessionAsyncSafe(
  workdir: string,
): Promise<Result<LinearContext | null, StoreReadError | AuthReadError>> {
  const storeResult = await readStoreSafe(getEffectiveStorePath());
  if (Result.isError(storeResult)) {
    return Result.err(storeResult.error);
  }

  const stored = readSessionByWorkdirFromData(storeResult.value, workdir);
  if (!stored) {
    return Result.ok(null);
  }

  const authResult = await readAuthSafe(getEffectiveAuthPath());
  if (Result.isError(authResult)) {
    return Result.err(authResult.error);
  }

  const token = getAuthAccessToken(authResult.value, stored.organizationId);
  if (!token) {
    return Result.ok(null);
  }

  return Result.ok({
    sessionId: stored.linearSessionId,
    issueId: stored.issueId,
    organizationId: stored.organizationId,
    workdir: stored.workdir,
  });
}
