import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Result } from "better-result";
import {
  type AuthRepository,
  getConfigPath,
  getStateRootPath,
} from "@opencode-linear-agent/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function readConfiguredOrganizationId(): Promise<
  Result<string | null, string>
> {
  const path = getConfigPath();
  const raw = await Result.tryPromise({
    try: async () => await readFile(path, "utf8"),
    catch: (error) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return { missing: true };
      }
      return `Failed to read config at ${path}: ${error instanceof Error ? error.message : String(error)}`;
    },
  });
  if (Result.isError(raw)) {
    if (typeof raw.error !== "string") {
      return Result.ok(null);
    }
    return Result.err(raw.error);
  }

  const parsed = await Result.tryPromise({
    try: async () => JSON.parse(raw.value) as unknown,
    catch: (error) =>
      `Failed to parse config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
  });
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }
  if (!isRecord(parsed.value)) {
    return Result.err(`Invalid config at ${path}: expected JSON object`);
  }

  return Result.ok(readOptionalString(parsed.value, "linearOrganizationId"));
}

async function inferOrganizationIdFromAuthState(): Promise<
  Result<string, string>
> {
  const authDir = join(getStateRootPath(), "auth");
  const files = await Result.tryPromise({
    try: async () => await readdir(authDir),
    catch: (error) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  });
  if (Result.isError(files)) {
    return Result.err(
      `Failed to read auth state at ${authDir}: ${files.error instanceof Error ? files.error.message : String(files.error)}`,
    );
  }

  const authFiles = files.value.filter((name) => name.endsWith(".json"));
  if (authFiles.length === 0) {
    return Result.err(
      "No Linear auth record found. Ensure the agent server has authenticated.",
    );
  }
  if (authFiles.length > 1) {
    return Result.err(
      "Multiple Linear auth records found. Set linearOrganizationId in config.",
    );
  }

  const file = authFiles[0];
  if (!file) {
    return Result.err("Missing auth state file.");
  }

  const path = join(authDir, file);
  const raw = await Result.tryPromise({
    try: async () => await readFile(path, "utf8"),
    catch: (error) =>
      `Failed to read auth state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
  });
  if (Result.isError(raw)) {
    return Result.err(raw.error);
  }

  const parsed = await Result.tryPromise({
    try: async () => JSON.parse(raw.value) as unknown,
    catch: (error) =>
      `Failed to parse auth state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
  });
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }

  const organizationId = readOptionalString(parsed.value, "organizationId");
  if (!organizationId) {
    return Result.err(`Invalid auth state at ${path}: missing organizationId`);
  }

  return Result.ok(organizationId);
}

export async function createToolTokenProvider(
  authRepository: AuthRepository,
): Promise<() => Promise<Result<string, string>>> {
  return async () => {
    const configuredOrganizationId = await readConfiguredOrganizationId();
    const organizationId = Result.isError(configuredOrganizationId)
      ? configuredOrganizationId
      : configuredOrganizationId.value
        ? Result.ok(configuredOrganizationId.value)
        : await inferOrganizationIdFromAuthState();

    if (Result.isError(organizationId)) {
      return Result.err(organizationId.error);
    }

    const token = await authRepository.getAccessToken(organizationId.value);
    if (!token) {
      return Result.err(
        `No valid Linear access token found for organization ${organizationId.value}.`,
      );
    }

    return Result.ok(token);
  };
}
