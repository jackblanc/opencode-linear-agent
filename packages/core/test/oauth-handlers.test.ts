import { beforeEach, describe, expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import type {
  KeyValueStore,
  OAuthConfig,
  RefreshTokenData,
  TokenStore,
} from "../src";

const { handleCallback, refreshAccessToken } =
  await import("../src/oauth/handlers");

class MemoryKeyValueStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async get<T>(_key: string): Promise<T | null> {
    return null;
  }

  async getString(key: string): Promise<string | null> {
    const value = this.data.get(key);
    return typeof value === "string" ? value : null;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

class MemoryTokenStore implements TokenStore {
  access = new Map<string, { token: string; ttl?: number }>();
  refresh = new Map<string, RefreshTokenData>();

  async getAccessToken(organizationId: string): Promise<string | null> {
    return this.access.get(organizationId)?.token ?? null;
  }

  async setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void> {
    this.access.set(organizationId, { token, ttl: expirationTtl });
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<RefreshTokenData | null> {
    return this.refresh.get(organizationId) ?? null;
  }

  async setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void> {
    this.refresh.set(organizationId, data);
  }
}

const config: OAuthConfig = {
  clientId: "client-1",
  clientSecret: "secret-1",
  baseUrl: "https://agent.example.com",
};

beforeEach(() => {
  Object.defineProperty(LinearClient.prototype, "viewer", {
    configurable: true,
    value: Promise.resolve({
      id: "app-1",
      name: "Linear Agent",
      organization: Promise.resolve({
        id: "org-1",
        name: "Acme",
      }),
    }),
  });

  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request) =>
      new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    globalThis.fetch,
  );
});

describe("oauth handlers", () => {
  test("handleCallback persists tokens via TokenStore", async () => {
    const kv = new MemoryKeyValueStore();
    const tokenStore = new MemoryTokenStore();
    await kv.put("oauth:state:state-1", "pending");

    const response = await handleCallback(
      new Request(
        "https://agent.example.com/api/oauth/callback?code=code-1&state=state-1",
      ),
      config,
      kv,
      tokenStore,
    );

    expect(response.status).toBe(200);
    expect(await tokenStore.getAccessToken("org-1")).toBe("access-1");
    expect(await tokenStore.getRefreshTokenData("org-1")).toEqual({
      refreshToken: "refresh-1",
      appId: "app-1",
      organizationId: "org-1",
      installedAt: expect.any(String),
      workspaceName: "Acme",
    });
    expect(await kv.getString("oauth:state:state-1")).toBeNull();
  });

  test("refreshAccessToken rotates access and refresh tokens", async () => {
    const tokenStore = new MemoryTokenStore();
    await tokenStore.setRefreshTokenData("org-1", {
      refreshToken: "refresh-old",
      appId: "app-1",
      organizationId: "org-1",
      installedAt: "2026-03-15T00:00:00.000Z",
      workspaceName: "Acme",
    });

    const token = await refreshAccessToken(config, tokenStore, "org-1");

    expect(token).toBe("access-1");
    expect(await tokenStore.getAccessToken("org-1")).toBe("access-1");
    expect((await tokenStore.getRefreshTokenData("org-1"))?.refreshToken).toBe(
      "refresh-1",
    );
  });
});
