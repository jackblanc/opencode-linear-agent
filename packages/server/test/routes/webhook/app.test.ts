import type { ApplicationConfig } from "@opencode-linear-agent/core";
import type { GetConnInfo } from "hono/conninfo";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { AuthRepository, SessionRepository, OpencodeService } from "@opencode-linear-agent/core";
import { beforeAll, describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";

import { createInMemoryAgentState } from "../../../../core/test/state/InMemoryAgentNamespace";
import { createWebhookApp } from "../../../src/routes/webhook/app";

const SECRET = "test-secret";
const ORG_ID = "org-1";

const config: ApplicationConfig = {
  webhookServerPublicHostname: "example.com",
  webhookServerPort: 3210,
  opencodeServerUrl: "http://localhost:4096",
  linearClientId: "client-id",
  linearClientSecret: "client-secret",
  linearWebhookSecret: SECRET,
  linearOrganizationId: ORG_ID,
};

function createRepositories() {
  const agentState = createInMemoryAgentState();
  return {
    auth: new AuthRepository(agentState),
    session: new SessionRepository(agentState),
  };
}

/** GetConnInfo that returns a whitelisted Linear IP */
const allowedConnInfo: GetConnInfo = () => ({
  remote: { address: "35.231.147.226", addressType: "IPv4", port: 443 },
});

/** GetConnInfo that returns a non-whitelisted IP */
const blockedConnInfo: GetConnInfo = () => ({
  remote: { address: "1.2.3.4", addressType: "IPv4", port: 443 },
});

function createSignedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", SECRET).update(body).digest("hex");
  return new Request("https://example.com/api/webhook/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": signature,
    },
    body,
  });
}

function issuePayload(organizationId: string = ORG_ID) {
  return {
    type: "Issue",
    action: "update",
    organizationId,
    issue: { id: "issue-1", identifier: "CODE-1" },
    data: {
      id: "issue-1",
      identifier: "CODE-1",
      state: { type: "started" },
    },
    webhookTimestamp: Date.now(),
  };
}

function unsupportedPayload(organizationId: string = ORG_ID) {
  return {
    type: "Document",
    action: "update",
    organizationId,
    webhookTimestamp: Date.now(),
  };
}

function agentSessionPayload(organizationId: string = ORG_ID) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId,
    appUserId: "app-user-1",
    oauthClientId: "oauth-client-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    agentSession: {
      id: "session-1",
      type: "AgentSession",
      appUserId: "app-user-1",
      organizationId,
      issueId: "issue-1",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      issue: {
        id: "issue-1",
        identifier: "CODE-1",
        title: "Test issue",
        url: "https://linear.app/example/CODE-1",
        teamId: "team-1",
        team: {
          id: "team-1",
          key: "CODE",
          name: "OpenCode",
        },
      },
    },
    promptContext: "Please help.",
  };
}

async function seedAuth(auth: AuthRepository) {
  await auth.putAuthRecord({
    organizationId: ORG_ID,
    accessToken: "test-access-token",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    refreshToken: "test-refresh-token",
    appId: "app-1",
    installedAt: new Date().toISOString(),
    workspaceName: "Test Workspace",
  });
}

const opencode = new OpencodeService(createOpencodeClient({ baseUrl: "http://test:0" }));

describe("webhook app", () => {
  const repos = createRepositories();

  beforeAll(async () => {
    await seedAuth(repos.auth);
  });

  test("accepts signed issue webhook from allowed IP", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const response = await app.request(createSignedRequest(issuePayload()));
    expect(response.status).toBe(200);
  });

  test("rejects request from non-whitelisted IP", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, blockedConnInfo);
    const response = await app.request(createSignedRequest(issuePayload()));
    expect(response.status).toBe(403);
  });

  test("rejects request missing linear-signature header", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const body = JSON.stringify(issuePayload());
    const request = new Request("https://example.com/api/webhook/linear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const response = await app.request(request);
    expect(response.status).toBe(400);
  });

  test("returns 200 for unsupported webhook type", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const response = await app.request(createSignedRequest(unsupportedPayload()));
    expect(response.status).toBe(200);
  });

  test("dispatches agent session webhooks to LinearEventProcessor", async () => {
    const seen: string[] = [];

    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo, {
      createProcessor: () => ({
        process: async () => {
          seen.push("called");
          return Promise.resolve();
        },
      }),
    });
    const response = await app.request(createSignedRequest(agentSessionPayload()));

    expect(response.status).toBe(200);
    expect(seen).toEqual(["called"]);
  });

  test("rejects webhook from wrong organization", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const response = await app.request(createSignedRequest(issuePayload("wrong-org")));
    expect(response.status).toBe(400);
  });

  test("rejects request with invalid signature", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const body = JSON.stringify(issuePayload());
    const wrongSignature = createHmac("sha256", "wrong-secret").update(body).digest("hex");
    const request = new Request("https://example.com/api/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": wrongSignature,
      },
      body,
    });
    const response = await app.request(request);
    expect(response.status).toBe(400);
  });

  test("rejects payload with invalid JSON body", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const body = "not json";
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    const request = new Request("https://example.com/api/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
      },
      body,
    });
    const response = await app.request(request);
    expect(response.status).toBe(400);
  });

  test("rejects payload missing webhookTimestamp", async () => {
    const app = createWebhookApp(config, repos.auth, repos.session, opencode, allowedConnInfo);
    const payload = { type: "Issue", action: "update", organizationId: ORG_ID };
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    const request = new Request("https://example.com/api/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
      },
      body,
    });
    const response = await app.request(request);
    expect(response.status).toBe(400);
  });
});
