import { describe, expect, test } from "bun:test";

import { AuthRepository } from "../../src/state/AuthRepository";
import { type AuthRecord } from "../../src/state/schema";
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
    const state = createInMemoryAgentState();
    const store = new AuthRepository(state);
    await store.putAuthRecord(
      createAuthRecord({ accessTokenExpiresAt: Date.now() - 1 }),
    );

    expect(await store.getAccessToken("org-1")).toBeNull();
    expect(await store.getAuthRecord("org-1")).not.toBeNull();
  });
});
