import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { handleWebhook } from "../src/webhook/handlers";
import type { EventDispatcher } from "../src/webhook/types";
import type { TokenStore } from "../src/storage/types";

function createSignedRequest(secret: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": signature,
    },
    body,
  });
}

function createTokenStore(accessToken: string | null): TokenStore {
  return {
    getAccessToken: async () => accessToken,
    setAccessToken: async () => undefined,
    getRefreshTokenData: async () => null,
    setRefreshTokenData: async () => undefined,
  };
}

describe("handleWebhook", () => {
  test("dispatches supported issue webhook", async () => {
    const secret = "test-secret";
    const dispatched: string[] = [];
    const dispatcher: EventDispatcher = {
      dispatch: async (event) => {
        dispatched.push(event.type);
      },
    };

    const request = createSignedRequest(secret, {
      type: "Issue",
      action: "update",
      organizationId: "org-1",
      data: {
        id: "issue-1",
        identifier: "CODE-1",
        state: { type: "completed" },
      },
      webhookTimestamp: Date.now(),
    });

    const response = await handleWebhook(
      request,
      secret,
      createTokenStore(null),
      dispatcher,
      undefined,
      "org-1",
    );

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toEqual(["Issue"]);
  });

  test("ignores unsupported webhook type", async () => {
    const secret = "test-secret";
    const dispatched: string[] = [];
    const dispatcher: EventDispatcher = {
      dispatch: async (event) => {
        dispatched.push(event.type);
      },
    };

    const request = createSignedRequest(secret, {
      type: "Document",
      action: "update",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
    });

    const response = await handleWebhook(
      request,
      secret,
      createTokenStore(null),
      dispatcher,
      undefined,
      "org-1",
    );

    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(0);
  });

  test("posts webhook received stage for agent session events", async () => {
    const secret = "test-secret";
    const stages: Array<{ sessionId: string; stage: string }> = [];
    const dispatcher: EventDispatcher = {
      dispatch: async () => undefined,
    };

    const request = createSignedRequest(secret, {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "session-1",
        issueId: "issue-1",
        issue: { id: "issue-1", identifier: "CODE-1" },
      },
      webhookTimestamp: Date.now(),
    });

    const response = await handleWebhook(
      request,
      secret,
      createTokenStore("token-1"),
      dispatcher,
      () => ({
        postStageActivity: async (sessionId, stage): Promise<void> => {
          stages.push({ sessionId, stage });
        },
      }),
      "org-1",
    );

    expect(response.status).toBe(200);
    expect(stages).toEqual([
      { sessionId: "session-1", stage: "webhook_received" },
    ]);
  });
});
