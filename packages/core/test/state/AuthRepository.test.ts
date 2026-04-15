import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { AuthRecord } from "../../src/state/schema";

import { KvNotFoundError } from "../../src/kv/errors";
import { AuthRepository } from "../../src/state/AuthRepository";
import { createInMemoryAgentState } from "./InMemoryAgentNamespace";

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

describe("AuthRepository", () => {
  test("stores one auth record per org", async () => {
    const state = createInMemoryAgentState();
    const store = new AuthRepository(state);
    const record = createAuthRecord();

    await store.putAuthRecord(record);

    expect(await store.getAuthRecord("org-1")).toEqual(Result.ok(record));
    expect(await store.getAccessToken("org-1")).toEqual(Result.ok("token-1"));
    expect(await store.getRefreshTokenData("org-1")).toEqual(
      Result.ok({
        refreshToken: "refresh-1",
        appId: "app-1",
        organizationId: "org-1",
        installedAt: record.installedAt,
        workspaceName: "workspace-1",
      }),
    );
  });

  test("hides expired access tokens but keeps auth record", async () => {
    const state = createInMemoryAgentState();
    const store = new AuthRepository(state);
    await store.putAuthRecord(createAuthRecord({ accessTokenExpiresAt: Date.now() - 1 }));

    expect(await store.getAccessToken("org-1")).toEqual(
      Result.err(new KvNotFoundError({ key: "org-1" })),
    );
    expect(Result.isOk(await store.getAuthRecord("org-1"))).toBe(true);
  });

  test("keeps saved auth record when token file mirror fails", async () => {
    const state = createInMemoryAgentState();
    const store = new AuthRepository(state, async () => Promise.reject(new Error("disk full")));
    const record = createAuthRecord();

    expect(await store.putAuthRecord(record)).toEqual(Result.ok(undefined));
    expect(await store.getAuthRecord("org-1")).toEqual(Result.ok(record));
  });
});
