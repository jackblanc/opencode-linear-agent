import type { z } from "zod";

import { Result } from "better-result";

import type { KvError } from "../../src/kv/errors";
import type { KeyValueStore } from "../../src/kv/types";

import { KvNotFoundError, KvSchemaError } from "../../src/kv/errors";

export class MemoryKeyValueStore<V> implements KeyValueStore<V> {
  constructor(
    private readonly schema: z.ZodType<V>,
    private readonly storage: Map<string, V> = new Map(),
  ) {}

  async has(key: string): Promise<Result<boolean, KvError>> {
    return Promise.resolve(Result.ok(this.storage.has(key)));
  }

  async get(key: string): Promise<Result<V, KvError>> {
    const value = this.storage.get(key);
    if (value === undefined) {
      return Promise.resolve(Result.err(new KvNotFoundError({ key })));
    }
    return Promise.resolve(Result.ok(value));
  }

  async put(key: string, value: V): Promise<Result<void, KvError>> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      return Promise.resolve(
        Result.err(
          new KvSchemaError({
            path: `memory:${key}`,
            issues: parsed.error.issues.map((i) => i.message),
          }),
        ),
      );
    }
    this.storage.set(key, parsed.data);
    return Promise.resolve(Result.ok(undefined));
  }

  async delete(key: string): Promise<Result<void, KvError>> {
    this.storage.delete(key);
    return Promise.resolve(Result.ok(undefined));
  }

  async withOperationLock<R>(
    _operation: string,
    fn: () => Promise<Result<R, KvError>>,
  ): Promise<Result<R, KvError>> {
    return fn();
  }
}
