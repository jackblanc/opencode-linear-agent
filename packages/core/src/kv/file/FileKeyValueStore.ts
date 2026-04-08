import type { z } from "zod";

import { Result } from "better-result";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { KvError } from "../errors";
import type { KeyValueStore } from "../types";

import { KvIoError, KvNotFoundError } from "../errors";
import { parseJson, stringifyJson } from "../json";
import { encodeKvKey } from "../key";
import { writeFileAtomic } from "./atomic";
import { withFileLock } from "./lock";

function fileKey(namespace: string, key: string): string {
  return `file:${namespace}:${key}`;
}

function operationKey(namespace: string, operation: string): string {
  return `op:${namespace}:${operation}`;
}

export class FileKeyValueStore<T> implements KeyValueStore<T> {
  private readonly namespacePath: string;

  constructor(
    private readonly namespace: string,
    private readonly rootPath: string,
    private readonly schema: z.ZodType<T>,
  ) {
    this.namespacePath = join(rootPath, namespace);
  }

  private getFilePath(key: string): Result<string, KvError> {
    const name = encodeKvKey(key);
    if (Result.isError(name)) {
      return Result.err(name.error);
    }

    return Result.ok(join(this.namespacePath, `${name.value}.json`));
  }

  async get(key: string): Promise<Result<T, KvError>> {
    const path = this.getFilePath(key);
    if (Result.isError(path)) {
      return Result.err(path.error);
    }

    const file = Bun.file(path.value);
    if (!(await file.exists())) {
      return Result.err(new KvNotFoundError({ key }));
    }

    const text = await Result.tryPromise({
      try: async () => readFile(path.value, "utf8"),
      catch: (error) =>
        new KvIoError({
          path: path.value,
          operation: "read",
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
    if (Result.isError(text)) {
      return Result.err(text.error);
    }

    return parseJson(text.value, path.value, this.schema);
  }

  async has(key: string): Promise<Result<boolean, KvError>> {
    const path = this.getFilePath(key);
    if (Result.isError(path)) {
      return Result.err(path.error);
    }

    return Result.ok(await Bun.file(path.value).exists());
  }

  async put(key: string, value: T): Promise<Result<void, KvError>> {
    const path = this.getFilePath(key);
    if (Result.isError(path)) {
      return Result.err(path.error);
    }

    const content = stringifyJson(value, path.value);
    if (Result.isError(content)) {
      return Result.err(content.error);
    }

    const dir = await Result.tryPromise({
      try: async () => {
        await mkdir(this.namespacePath, { recursive: true });
      },
      catch: (error) =>
        new KvIoError({
          path: this.namespacePath,
          operation: "mkdir",
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
    if (Result.isError(dir)) {
      return Result.err(dir.error);
    }

    return withFileLock(this.rootPath, fileKey(this.namespace, key), async () =>
      writeFileAtomic(path.value, content.value),
    );
  }

  async delete(key: string): Promise<Result<void, KvError>> {
    const path = this.getFilePath(key);
    if (Result.isError(path)) {
      return Result.err(path.error);
    }

    return withFileLock(this.rootPath, fileKey(this.namespace, key), async () =>
      Result.tryPromise({
        try: async () => {
          await rm(path.value, { force: true });
        },
        catch: (error) =>
          new KvIoError({
            path: path.value,
            operation: "delete",
            reason: error instanceof Error ? error.message : String(error),
          }),
      }),
    );
  }

  async withOperationLock<V>(
    operation: string,
    fn: () => Promise<Result<V, KvError>>,
  ): Promise<Result<V, KvError>> {
    return withFileLock(this.rootPath, operationKey(this.namespace, operation), fn);
  }
}
