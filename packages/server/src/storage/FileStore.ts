/**
 * File-based implementation of KeyValueStore
 *
 * Stores all key-value pairs in a single JSON file.
 * Handles TTL expiration on read.
 *
 * WARNING: This implementation does not handle concurrent writes.
 * If multiple requests modify the store simultaneously, data could be lost.
 * This is acceptable for local development where requests are typically
 * serialized, but should not be used in production environments with
 * concurrent access. Consider using a proper database or adding file
 * locking if concurrent access is required.
 */

import { mkdir, writeFile, readFile, exists } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getStorePath,
  parseStoreData,
  type KeyValueStore,
  type StoreData,
  type StoredValue,
} from "@opencode-linear-agent/core";

/**
 * File-based KeyValueStore implementation
 */
export class FileStore implements KeyValueStore {
  private data: StoreData = {};
  private loaded = false;
  private filePath: string;

  constructor(filePath = getStorePath()) {
    this.filePath = filePath;
  }

  /**
   * Ensure the store is loaded from disk
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.reload();
  }

  /**
   * Force reload the store from disk.
   * Use this when expecting changes from external processes (e.g., plugin).
   */
  private async reload(): Promise<void> {
    if (!(await exists(this.filePath))) {
      this.data = {};
      this.loaded = true;
      return;
    }

    const file = await readFile(this.filePath);

    try {
      const json: unknown = JSON.parse(file.toString());
      this.data = parseStoreData(json);
    } catch {
      // File exists but is invalid - start fresh
      this.data = {};
    }

    this.loaded = true;
  }

  /**
   * Save the store to disk
   */
  private async save(): Promise<void> {
    // Ensure directory exists
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Check if a stored value has expired
   */
  private isExpired(stored: StoredValue): boolean {
    if (!stored.expires) {
      return false;
    }
    return Date.now() > stored.expires;
  }

  async get<T>(key: string): Promise<T | null> {
    // Always re-read from disk to pick up changes from other processes (e.g., plugin)
    await this.reload();

    const stored = this.data[key];
    if (!stored) {
      return null;
    }

    // Check expiration
    if (this.isExpired(stored)) {
      delete this.data[key];
      await this.save();
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic KV store requires type assertion
    return stored.value as T;
  }

  async getString(key: string): Promise<string | null> {
    const value = await this.get<string>(key);
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    return value;
  }

  async put(
    key: string,
    value: unknown,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    await this.ensureLoaded();

    const stored: StoredValue = { value };

    if (options?.expirationTtl) {
      // Convert TTL in seconds to expiration timestamp in milliseconds
      stored.expires = Date.now() + options.expirationTtl * 1000;
    }

    this.data[key] = stored;
    await this.save();
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded();

    if (key in this.data) {
      delete this.data[key];
      await this.save();
    }
  }

  /**
   * Clean up expired entries (optional maintenance method)
   */
  async cleanup(): Promise<number> {
    await this.ensureLoaded();

    let cleaned = 0;
    const now = Date.now();

    for (const key of Object.keys(this.data)) {
      const stored = this.data[key];
      if (stored?.expires && now > stored.expires) {
        delete this.data[key];
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.save();
    }

    return cleaned;
  }
}
