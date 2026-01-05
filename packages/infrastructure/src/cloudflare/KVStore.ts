import type { KeyValueStore } from "../types";

/**
 * Cloudflare KV implementation of KeyValueStore
 */
export class KVStore implements KeyValueStore {
  constructor(private readonly kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(key, "json");
  }

  async getString(key: string): Promise<string | null> {
    return this.kv.get(key, "text");
  }

  async put(
    key: string,
    value: unknown,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    await this.kv.put(key, serialized, options);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
