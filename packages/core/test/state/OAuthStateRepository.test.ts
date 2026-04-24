import { Result } from "better-result";
import { describe, expect, test } from "vitest";

import { OAuthStateRepository } from "../../src/state/OAuthStateRepository";
import { createInMemoryAgentState } from "./InMemoryAgentNamespace";

describe("OAuthStateRepository", () => {
  test("issues and consumes valid oauth state", async () => {
    const state = createInMemoryAgentState();
    const store = new OAuthStateRepository(state);
    const now = Date.now();

    await store.issue("state-1", now, now + 60_000);

    expect(await store.consume("state-1", now + 1)).toEqual(Result.ok(undefined));
    expect(await state.oauthState.has("state-1")).toEqual(Result.ok(false));
  });

  test("rejects expired oauth state and deletes it", async () => {
    const state = createInMemoryAgentState();
    const store = new OAuthStateRepository(state);
    const now = Date.now();

    await store.issue("state-1", now, now + 10);

    expect(await store.consume("state-1", now + 11).then((r) => r.isErr())).toBe(true);
    expect(await state.oauthState.has("state-1")).toEqual(Result.ok(false));
  });
});
