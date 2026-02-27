import { describe, expect, test } from "bun:test";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import {
  PromptBuilder,
  type PromptContext,
} from "../../src/session/PromptBuilder";

const ctx: PromptContext = {
  linearSessionId: "linear-session-1",
  organizationId: "org-1",
  workdir: "/tmp/workdir",
};

function buildEvent(promptContext: string): AgentSessionEventWebhookPayload {
  return {
    type: "AgentSessionEvent",
    action: "created",
    appUserId: "app-user-1",
    oauthClientId: "oauth-client-1",
    organizationId: "org-1",
    webhookId: "webhook-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    webhookTimestamp: Date.now(),
    agentSession: {
      id: "session-1",
      type: "AgentSession",
      appUserId: "app-user-1",
      organizationId: "org-1",
      issueId: "issue-1",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      issue: {
        id: "issue-1",
        identifier: "CODE-141",
        title: "Prompt filter",
        url: "https://linear.app/example/CODE-141",
        teamId: "team-1",
        team: {
          id: "team-1",
          key: "CODE",
          name: "OpenCode",
        },
      },
    },
    promptContext,
  };
}

describe("PromptBuilder", () => {
  test("removes other-thread content from created prompt", () => {
    const b = new PromptBuilder();
    const event = buildEvent(`<issue>details</issue>
<primary-directive-thread comment-id="1">build it</primary-directive-thread>
<other-thread comment-id="2">old session details</other-thread>`);

    const prompt = b.buildCreatedPrompt(event, ctx, "build");

    expect(prompt).toContain("<primary-directive-thread");
    expect(prompt).not.toContain("<other-thread");
    expect(prompt).not.toContain("old session details");
  });

  test("falls back when filtered prompt is empty", () => {
    const b = new PromptBuilder();
    const event = buildEvent(
      `<other-thread comment-id="2">old session details</other-thread>`,
    );

    const prompt = b.buildCreatedPrompt(event, ctx, "build");

    expect(prompt).toContain("Please help with this issue.");
    expect(prompt).not.toContain("<other-thread");
  });
});
