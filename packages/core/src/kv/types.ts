import type { Result } from "better-result";

import type { KvError } from "./errors";

export interface KvNamespaceStore<T> {
  get(key: string): Promise<Result<T | null, KvError>>;
  has(key: string): Promise<Result<boolean, KvError>>;
  put(key: string, value: T): Promise<Result<void, KvError>>;
  delete(key: string): Promise<Result<void, KvError>>;
  readonly namespace: string;
  readonly namespacePath: string;
  withOperationLock<V>(
    operation: string,
    fn: () => Promise<Result<V, KvError>>,
  ): Promise<Result<V, KvError>>;
}
