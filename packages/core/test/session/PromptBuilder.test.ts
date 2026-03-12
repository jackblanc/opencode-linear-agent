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
  test("builds compact prompt with latest directive last", () => {
    const b = new PromptBuilder();
    const event = buildEvent(`
<issue>details</issue>
<primary-directive-thread comment-id="1"><comment author="Jack">is this worth doing?</comment></primary-directive-thread>
<other-thread comment-id="2">old session details</other-thread>`);

    const prompt = b.buildCreatedPrompt(
      event,
      ctx,
      "build",
      {
        id: "issue-1",
        identifier: "CODE-141",
        title: "Prompt filter",
        description: "Keep prompts short.\n\nRemove duplicates.",
        url: "https://linear.app/example/CODE-141",
        relations: {
          related: [
            { id: "issue-2", identifier: "CODE-215", title: "Earlier work" },
          ],
          blocks: [],
          blockedBy: [],
          duplicate: [],
        },
      },
      "## Previous Session Context\n\nOld context.",
    );

    expect(prompt).toContain("## Build Mode");
    expect(prompt).toContain("# Issue");
    expect(prompt).toContain("## Description");
    expect(prompt).toContain("## Related Issues");
    expect(prompt).toContain("CODE-215 - Earlier work");
    expect(prompt).toContain("## Previous Session Context");
    expect(prompt).not.toContain("<primary-directive-thread");
    expect(prompt).not.toContain("<other-thread");
    expect(prompt.trim().endsWith("is this worth doing?")).toBeTrue();
  });

  test("falls back when primary directive is missing", () => {
    const b = new PromptBuilder();
    const event = buildEvent(
      '<other-thread comment-id="2">old session details</other-thread>',
    );

    const prompt = b.buildCreatedPrompt(event, ctx, "build");

    expect(prompt).toContain("Please help with this issue.");
    expect(prompt).not.toContain("<other-thread");
  });

  test("recreated follow-up keeps latest user response last", () => {
    const b = new PromptBuilder();
    const event = buildEvent("ignored");

    const prompt = b.buildFollowUpPrompt(
      event,
      "Please keep the change minimal.",
      ctx,
      "build",
      undefined,
      "## Previous Session Context\n\nOld context.",
    );

    expect(prompt).toContain("## Latest User Directive");
    expect(
      prompt.trim().endsWith("Please keep the change minimal."),
    ).toBeTrue();
  });
});
