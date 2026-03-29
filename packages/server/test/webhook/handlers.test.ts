import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { handleWebhook } from "../../src/webhook/handlers";
import type { EventDispatcher } from "../../src/webhook/types";

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

    const response = await handleWebhook(request, secret, dispatcher, "org-1");

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

    const response = await handleWebhook(request, secret, dispatcher, "org-1");

    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(0);
  });
});
