import { Result } from "better-result";
import type { KvError } from "../../src/kv/errors";
import type { KeyValueStore } from "../../src/kv/types";

type Method = "get" | "has" | "put" | "delete";

/**
 * Wraps a KeyValueStore and injects a one-shot error on a specified method.
 * After the error fires once it is cleared automatically.
 */
export class FailingKeyValueStore<V> implements KeyValueStore<V> {
  private pendingFailure: { method: Method; error: KvError } | null = null;

  constructor(private readonly delegate: KeyValueStore<V>) {}

  failOnce(method: Method, error: KvError): void {
    this.pendingFailure = { method, error };
  }

  private consume(method: Method): KvError | null {
    if (this.pendingFailure && this.pendingFailure.method === method) {
      const err = this.pendingFailure.error;
      this.pendingFailure = null;
      return err;
    }
    return null;
  }

  async get(key: string): Promise<Result<V, KvError>> {
    const err = this.consume("get");
    if (err) return Result.err(err);
    return this.delegate.get(key);
  }

  async has(key: string): Promise<Result<boolean, KvError>> {
    const err = this.consume("has");
    if (err) return Result.err(err);
    return this.delegate.has(key);
  }

  async put(key: string, value: V): Promise<Result<void, KvError>> {
    const err = this.consume("put");
    if (err) return Result.err(err);
    return this.delegate.put(key, value);
  }

  async delete(key: string): Promise<Result<void, KvError>> {
    const err = this.consume("delete");
    if (err) return Result.err(err);
    return this.delegate.delete(key);
  }

  async withOperationLock<R>(
    operation: string,
    fn: () => Promise<Result<R, KvError>>,
  ): Promise<Result<R, KvError>> {
    return this.delegate.withOperationLock(operation, fn);
  }
}
