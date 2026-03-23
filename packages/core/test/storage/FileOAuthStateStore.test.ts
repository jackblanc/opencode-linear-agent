import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { FileOAuthStateStore } from "../../src/storage/FileOAuthStateStore";

const TEST_DIR = join(import.meta.dir, ".test-oauth-state-store");
const TEST_STATE_ROOT = join(TEST_DIR, "state");

describe("FileOAuthStateStore", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("issues and consumes valid oauth state", async () => {
    const store = new FileOAuthStateStore(TEST_STATE_ROOT);
    const now = Date.now();

    await store.issue("state-1", now, now + 60_000);

    expect(await store.consume("state-1", now + 1)).toBe(true);
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "oauth-state", "state-1.json"),
      ).exists(),
    ).toBe(false);
  });

  test("rejects expired oauth state and deletes it", async () => {
    const store = new FileOAuthStateStore(TEST_STATE_ROOT);
    const now = Date.now();

    await store.issue("state-1", now, now + 10);

    expect(await store.consume("state-1", now + 11)).toBe(false);
    expect(
      await Bun.file(
        join(TEST_STATE_ROOT, "oauth-state", "state-1.json"),
      ).exists(),
    ).toBe(false);
  });
});
