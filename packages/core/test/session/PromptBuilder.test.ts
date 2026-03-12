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
  test("prepends build reminder and preserves raw Linear prompt", () => {
    const b = new PromptBuilder();
    const raw = `<issue identifier="ENG-123"><title>Fix accessibility on checkout page</title></issue>

<primary-directive-thread comment-id="1"><comment>Please implement this</comment></primary-directive-thread>`;

    const prompt = b.buildCreatedPrompt(buildEvent(raw), ctx, "build");

    expect(prompt).toContain("<system-reminder>");
    expect(prompt).toContain(
      "Your operational mode has changed from plan to build.",
    );
    expect(prompt).toContain(raw);
    expect(prompt.trim().endsWith("</primary-directive-thread>")).toBeTrue();
  });

  test("uses fallback text when Linear prompt missing", () => {
    const b = new PromptBuilder();
    const prompt = b.buildCreatedPrompt(buildEvent(""), ctx, "build");

    expect(prompt).toContain("Please help with this issue.");
  });

  test("recreated follow-up prepends plan reminder and previous context", () => {
    const b = new PromptBuilder();
    const prompt = b.buildFollowUpPrompt(
      buildEvent("ignored"),
      "Keep it short.",
      ctx,
      "plan",
      undefined,
      "## Previous Session Context\n\nOld context.",
    );

    expect(prompt).toContain("Your operational mode is plan.");
    expect(prompt).toContain("## Previous Session Context");
    expect(prompt.trim().endsWith("Keep it short.")).toBeTrue();
  });
});
