import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Result } from "better-result";

import type {
  PendingPermission,
  PendingQuestion,
} from "../session/SessionRepository";
import { FileSessionRepository } from "../session/FileSessionRepository";
import { getStateRootPath } from "../paths";
import { parseJson } from "../kv/json";
import { createFileStateRoot } from "../kv/file/FileStateRoot";
import { KvIoError, type KvError } from "../kv/errors";
import { createFileAgentState } from "../state/root";
import { authAccessTokenSchema } from "../state/schema";

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

let stateRootPath: string | null = null;

function getEffectiveStateRootPath(): string {
  if (stateRootPath) {
    return stateRootPath;
  }

  return getStateRootPath();
}

function createAgentState() {
  return createFileAgentState(getEffectiveStateRootPath());
}

function createAccessTokenStore() {
  return createFileStateRoot(getEffectiveStateRootPath()).namespace(
    "auth",
    authAccessTokenSchema,
  );
}

export function setStateRootPath(path: string): void {
  stateRootPath = path;
}

function toStoreReadError(error: KvError): StoreReadError {
  if (error._tag === "KvJsonParseError") {
    return {
      kind: "parse_error",
      path: error.path,
      message: error.message,
    };
  }

  if (error._tag === "KvSchemaError") {
    return {
      kind: "schema_error",
      path: error.path,
      message: error.message,
    };
  }

  return {
    kind: "io_error",
    path: "path" in error ? error.path : getEffectiveStateRootPath(),
    message: error.message,
  };
}

export function formatStoreReadError(error: StoreReadError): string {
  const reason =
    error.kind === "parse_error"
      ? "invalid JSON"
      : error.kind === "schema_error"
        ? "invalid state schema"
        : "state read failure";

  return [
    `Linear state read failed (${reason}) at ${error.path}.`,
    `Cause: ${error.message}`,
    "Recovery: fix or remove the bad state file, restart agent server, then re-run Linear auth if auth data was lost.",
  ].join(" ");
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
  const store = createAccessTokenStore();
  const rec = await store.get(organizationId);
  if (Result.isError(rec)) {
    return Result.err(toStoreReadError(rec.error));
  }
  if (!rec.value || rec.value.accessTokenExpiresAt <= Date.now()) {
    return Result.ok(null);
  }
  return Result.ok(rec.value.accessToken);
}

export async function readAnyAccessTokenSafe(): Promise<
  Result<string | null, StoreReadError>
> {
  const dir = createAgentState().auth.namespacePath;
  if (!existsSync(dir)) {
    return Result.ok(null);
  }

  const files = await Result.tryPromise({
    try: async () => await readdir(dir),
    catch: (error) =>
      new KvIoError({
        path: dir,
        operation: "read",
        reason: error instanceof Error ? error.message : String(error),
      }),
  });
  if (Result.isError(files)) {
    return Result.err(toStoreReadError(files.error));
  }

  const names = files.value.toSorted();

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const path = join(dir, name);
    const text = await Result.tryPromise({
      try: async () => await readFile(path, "utf8"),
      catch: (error) =>
        new KvIoError({
          path,
          operation: "read",
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
    if (Result.isError(text)) {
      return Result.err(toStoreReadError(text.error));
    }

    const parsed = parseJson(text.value, path, authAccessTokenSchema);
    if (Result.isError(parsed)) {
      return Result.err(toStoreReadError(parsed.error));
    }

    if (parsed.value.accessTokenExpiresAt > Date.now()) {
      return Result.ok(parsed.value.accessToken);
    }
  }

  return Result.ok(null);
}

export async function getSessionByOpencodeSessionId(
  opencodeSessionId: string,
): Promise<LinearContext | null> {
  const root = createAgentState();
  const idx = await root.sessionByOpencode.get(opencodeSessionId);
  if (Result.isError(idx) || !idx.value) {
    return null;
  }

  const session = await root.session.get(idx.value.linearSessionId);
  if (Result.isError(session) || !session.value) {
    await root.sessionByOpencode.delete(opencodeSessionId);
    return null;
  }

  return {
    sessionId: session.value.linearSessionId,
    issueId: session.value.issueId,
    organizationId: session.value.organizationId,
    workdir: session.value.workdir,
  };
}

export async function savePendingQuestion(
  question: PendingQuestion,
): Promise<void> {
  const repository = new FileSessionRepository(getEffectiveStateRootPath());
  await repository.savePendingQuestion(question);
}

export async function savePendingPermission(
  permission: PendingPermission,
): Promise<void> {
  const repository = new FileSessionRepository(getEffectiveStateRootPath());
  await repository.savePendingPermission(permission);
}
