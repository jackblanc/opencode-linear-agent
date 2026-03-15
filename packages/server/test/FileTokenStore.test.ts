import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RefreshTokenData } from "@opencode-linear-agent/core";
import { FileTokenStore } from "../src/storage/FileTokenStore";

const TEST_DIR = join(import.meta.dir, ".test-filetokenstore");
const TEST_AUTH_PATH = join(TEST_DIR, "auth.json");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("FileTokenStore", () => {
  test("persists access and refresh tokens to auth.json", async () => {
    const store = new FileTokenStore(TEST_AUTH_PATH);
    const refresh: RefreshTokenData = {
      refreshToken: "refresh-1",
      appId: "app-1",
      organizationId: "org-1",
      installedAt: "2026-03-15T00:00:00.000Z",
      workspaceName: "Acme",
    };

    await store.setAccessToken("org-1", "access-1", 3600);
    await store.setRefreshTokenData("org-1", refresh);

    expect(await store.getAccessToken("org-1")).toBe("access-1");
    expect(await store.getRefreshTokenData("org-1")).toEqual(refresh);

    const stored = JSON.parse(await readFile(TEST_AUTH_PATH, "utf-8"));
    expect(stored.version).toBe(1);
    expect(stored.organizations["org-1"].accessToken.value).toBe("access-1");
    expect(stored.organizations["org-1"].refreshToken.refreshToken).toBe(
      "refresh-1",
    );
  });

  test("drops expired access tokens", async () => {
    await Bun.write(
      TEST_AUTH_PATH,
      JSON.stringify({
        version: 1,
        organizations: {
          "org-1": {
            accessToken: {
              value: "expired",
              expiresAt: Date.now() - 1000,
            },
          },
        },
      }),
    );

    const store = new FileTokenStore(TEST_AUTH_PATH);

    expect(await store.getAccessToken("org-1")).toBeNull();

    const stored = JSON.parse(await readFile(TEST_AUTH_PATH, "utf-8"));
    expect(stored.organizations["org-1"].accessToken).toBeUndefined();
  });

  test("throws for invalid auth schema", async () => {
    await Bun.write(TEST_AUTH_PATH, JSON.stringify({ bad: true }));
    const store = new FileTokenStore(TEST_AUTH_PATH);

    await store.getRefreshTokenData("org-1").then(
      () => {
        throw new Error("expected invalid auth data error");
      },
      (error: unknown) => {
        expect(
          error instanceof Error ? error.message : String(error),
        ).toContain("Invalid auth data");
      },
    );
  });

  test("preserves concurrent writes across store instances", async () => {
    await Bun.write(
      TEST_AUTH_PATH,
      JSON.stringify({ version: 1, organizations: {} }),
    );

    const a = new FileTokenStore(TEST_AUTH_PATH);
    const b = new FileTokenStore(TEST_AUTH_PATH);
    const refresh: RefreshTokenData = {
      refreshToken: "refresh-1",
      appId: "app-1",
      organizationId: "org-1",
      installedAt: "2026-03-15T00:00:00.000Z",
      workspaceName: "Acme",
    };

    await Promise.all([
      a.setAccessToken("org-1", "access-1", 3600),
      b.setRefreshTokenData("org-1", refresh),
    ]);

    const stored = JSON.parse(await readFile(TEST_AUTH_PATH, "utf-8"));
    expect(stored.organizations["org-1"].accessToken.value).toBe("access-1");
    expect(stored.organizations["org-1"].refreshToken).toEqual(refresh);
  });
});
