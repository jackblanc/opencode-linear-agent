import { describe, test, expect } from "bun:test";
import {
  isIssueEvent,
  isCompletedStateChange,
} from "../../src/webhook/issueHandler";
import type {
  LinearWebhookPayload,
  EntityWebhookPayloadWithIssueData,
} from "@linear/sdk/webhooks";

function createWebhookPayload(
  type: string,
  action: string,
  data?: Record<string, unknown>,
): LinearWebhookPayload {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test helper for creating partial payloads
  return { type, action, data } as any;
}

function createIssuePayload(
  action: string,
  state?: { type: string; name: string },
): EntityWebhookPayloadWithIssueData {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test helper for creating partial payloads
  return {
    type: "Issue",
    action,
    data: {
      identifier: "CODE-123",
      ...(state && { state }),
    },
  } as unknown as EntityWebhookPayloadWithIssueData;
}

describe("isIssueEvent", () => {
  test("returns true for Issue webhook payload", () => {
    const payload = createWebhookPayload("Issue", "update", {
      identifier: "CODE-123",
    });
    expect(isIssueEvent(payload)).toBe(true);
  });

  test("returns false for AgentSessionEvent payload", () => {
    const payload = createWebhookPayload("AgentSessionEvent", "created");
    expect(isIssueEvent(payload)).toBe(false);
  });

  test("returns false for Comment payload", () => {
    const payload = createWebhookPayload("Comment", "create");
    expect(isIssueEvent(payload)).toBe(false);
  });
});

describe("isCompletedStateChange", () => {
  test("returns true for update action with completed state type", () => {
    const payload = createIssuePayload("update", {
      type: "completed",
      name: "Done",
    });
    expect(isCompletedStateChange(payload)).toBe(true);
  });

  test("returns true for update action with canceled state type", () => {
    const payload = createIssuePayload("update", {
      type: "canceled",
      name: "Canceled",
    });
    expect(isCompletedStateChange(payload)).toBe(true);
  });

  test("returns false for update action with started state type", () => {
    const payload = createIssuePayload("update", {
      type: "started",
      name: "In Progress",
    });
    expect(isCompletedStateChange(payload)).toBe(false);
  });

  test("returns false for update action with unstarted state type", () => {
    const payload = createIssuePayload("update", {
      type: "unstarted",
      name: "Backlog",
    });
    expect(isCompletedStateChange(payload)).toBe(false);
  });

  test("returns false for create action even with completed state", () => {
    const payload = createIssuePayload("create", {
      type: "completed",
      name: "Done",
    });
    expect(isCompletedStateChange(payload)).toBe(false);
  });

  test("returns false for remove action", () => {
    const payload = createIssuePayload("remove", {
      type: "completed",
      name: "Done",
    });
    expect(isCompletedStateChange(payload)).toBe(false);
  });

  test("returns false when state is missing", () => {
    const payload = createIssuePayload("update");
    expect(isCompletedStateChange(payload)).toBe(false);
  });
});
