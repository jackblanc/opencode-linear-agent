import { readFile } from "node:fs/promises";

import { Result } from "better-result";

import {
  type PendingPermission,
  type PendingQuestion,
} from "../session/SessionRepository";
import { FileSessionRepository } from "../session/FileSessionRepository";
import { getStorePath } from "../paths";
import { parseStoreData, type StoreData } from "../schemas";
import { FileStore } from "./FileStore";

export interface LinearContext {
  sessionId: string | null;
  issueId: string;
  organizationId: string;
  workdir: string;
}

type StoreReadErrorKind = "parse_error" | "schema_error" | "io_error";

interface StoreReadError {
  kind: StoreReadErrorKind;
  path: string;
  message: string;
}

interface StoredSession {
  opencodeSessionId: string;
  linearSessionId: string;
  issueId: string;
  branchName: string;
  workdir: string;
  lastActivityTime: number;
}

const ACCESS_TOKEN_PREFIX = "token:access:";
const SESSION_PREFIX = "session:";

let storePath: string | null = null;

function getEffectiveStorePath(): string {
  if (storePath) {
    return storePath;
  }

  const path = getStorePath();
  storePath = path;
  return path;
}

function createFileStore(): FileStore {
  return new FileStore(getEffectiveStorePath());
}

export function setStorePath(path: string): void {
  storePath = path;
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

  if (error instanceof SyntaxError || message.includes("JSON")) {
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

async function readStoreSafe(): Promise<Result<StoreData, StoreReadError>> {
  const path = getEffectiveStorePath();
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return Result.ok({});
  }

  return Result.tryPromise({
    try: async () => {
      const text = await readFile(path, "utf8");
      const json: unknown = JSON.parse(text);
      return parseStoreData(json);
    },
    catch: (error) => toStoreReadError(error, path),
  });
}

function getValue<T>(data: StoreData, key: string): T | null {
  const stored = data[key];
  if (!stored) {
    return null;
  }

  if (stored.expires && Date.now() > stored.expires) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Generic KV store requires type assertion
  return stored.value as T;
}

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
  const data = await readStoreSafe();
  if (Result.isError(data)) {
    return Result.err(data.error);
  }

  return Result.ok(
    getValue<string>(data.value, `${ACCESS_TOKEN_PREFIX}${organizationId}`),
  );
}

export async function readAnyAccessTokenSafe(): Promise<
  Result<string | null, StoreReadError>
> {
  const data = await readStoreSafe();
  if (Result.isError(data)) {
    return Result.err(data.error);
  }

  for (const key of Object.keys(data.value)) {
    if (!key.startsWith(ACCESS_TOKEN_PREFIX)) {
      continue;
    }

    const token = getValue<string>(data.value, key);
    if (token) {
      return Result.ok(token);
    }
  }

  return Result.ok(null);
}

async function readAnyAccessTokenWithOrg(): Promise<{
  token: string;
  organizationId: string;
} | null> {
  const data = await readStoreSafe();
  if (Result.isError(data)) {
    return null;
  }

  for (const key of Object.keys(data.value)) {
    if (!key.startsWith(ACCESS_TOKEN_PREFIX)) {
      continue;
    }

    const token = getValue<string>(data.value, key);
    if (token) {
      return {
        token,
        organizationId: key.slice(ACCESS_TOKEN_PREFIX.length),
      };
    }
  }

  return null;
}

async function readSessionByOpencodeSessionId(
  opencodeSessionId: string,
): Promise<StoredSession | null> {
  const data = await readStoreSafe();
  if (Result.isError(data)) {
    return null;
  }

  let latest: StoredSession | null = null;

  for (const key of Object.keys(data.value)) {
    if (!key.startsWith(SESSION_PREFIX)) {
      continue;
    }

    const session = getValue<StoredSession>(data.value, key);
    if (!session || session.opencodeSessionId !== opencodeSessionId) {
      continue;
    }

    if (!latest || session.lastActivityTime > latest.lastActivityTime) {
      latest = session;
    }
  }

  return latest;
}

export async function getSessionByOpencodeSessionId(
  opencodeSessionId: string,
): Promise<LinearContext | null> {
  const session = await readSessionByOpencodeSessionId(opencodeSessionId);
  if (!session) {
    return null;
  }

  const tokenInfo = await readAnyAccessTokenWithOrg();
  if (!tokenInfo) {
    return null;
  }

  return {
    sessionId: session.linearSessionId,
    issueId: session.issueId,
    organizationId: tokenInfo.organizationId,
    workdir: session.workdir,
  };
}

export async function savePendingQuestion(
  question: PendingQuestion,
): Promise<void> {
  const repository = new FileSessionRepository(createFileStore());
  await repository.savePendingQuestion(question);
}

export async function savePendingPermission(
  permission: PendingPermission,
): Promise<void> {
  const repository = new FileSessionRepository(createFileStore());
  await repository.savePendingPermission(permission);
}
