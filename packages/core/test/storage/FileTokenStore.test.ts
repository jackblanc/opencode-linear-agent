import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FileTokenStore } from "../../src/storage/FileTokenStore";
import type { AuthRecord } from "../../src/storage/types";

const TEST_DIR = join(import.meta.dir, ".test-token-store");
const TEST_STATE_ROOT = join(TEST_DIR, "state");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(value));
}

function createAuthRecord(overrides: Partial<AuthRecord> = {}): AuthRecord {
  return {
    organizationId: "org-1",
    accessToken: "token-1",
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: "refresh-1",
    appId: "app-1",
    installedAt: new Date().toISOString(),
    workspaceName: "workspace-1",
    ...overrides,
  };
}

describe("FileTokenStore", () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("stores one auth record per org", async () => {
    const store = new FileTokenStore(TEST_STATE_ROOT);
    const record = createAuthRecord();

    await store.putAuthRecord(record);

    expect(await store.getAuthRecord("org-1")).toEqual(record);
    expect(await store.getAccessToken("org-1")).toBe("token-1");
    expect(await store.getRefreshTokenData("org-1")).toEqual({
      refreshToken: "refresh-1",
      appId: "app-1",
      organizationId: "org-1",
      installedAt: record.installedAt,
      workspaceName: "workspace-1",
    });
  });

  test("hides expired access tokens but keeps auth record", async () => {
    const store = new FileTokenStore(TEST_STATE_ROOT);
    await store.putAuthRecord(
      createAuthRecord({ accessTokenExpiresAt: Date.now() - 1 }),
    );

    expect(await store.getAccessToken("org-1")).toBeNull();
    expect(await store.getAuthRecord("org-1")).not.toBeNull();
  });

  test("rejects malformed auth record when reading access token", async () => {
    await writeJson(join(TEST_STATE_ROOT, "auth", "org-1.json"), {
      organizationId: "org-1",
      accessToken: "token-1",
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshToken: "refresh-1",
    });

    const store = new FileTokenStore(TEST_STATE_ROOT);

    const error = await store
      .getAccessToken("org-1")
      .then(() => null)
      .catch((failure: unknown) =>
        failure instanceof Error ? failure : new Error(String(failure)),
      );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("Schema validation failed");
  });

  test("persists auth record json under storage root", async () => {
    const store = new FileTokenStore(TEST_STATE_ROOT);
    const record = createAuthRecord();

    await store.putAuthRecord(record);

    expect(
      JSON.parse(
        await readFile(join(TEST_STATE_ROOT, "auth", "org-1.json"), "utf8"),
      ),
    ).toEqual(record);
  });
});
