import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FileStore } from "../src/storage/FileStore";

const TEST_DIR = join(import.meta.dir, ".test-filestore");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("FileStore", () => {
  test("uses injected file path", async () => {
    const filePath = join(TEST_DIR, "store.json");
    const store = new FileStore(filePath);

    await store.put("k", "v");

    expect(await store.getString("k")).toBe("v");
    expect(await Bun.file(filePath).exists()).toBe(true);
  });
});
