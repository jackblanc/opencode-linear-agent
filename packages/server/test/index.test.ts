import { describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { Result } from "better-result";
import {
  OpencodeService,
  type LinearService,
  type SessionRepository,
} from "@opencode-linear-agent/core";
import { dispatchAgentSessionEvent } from "../src/index";

function createEvent(): AgentSessionEventWebhookPayload {
  const event = {
    type: "AgentSessionEvent",
    action: "created",
    appUserId: "app-user-1",
    oauthClientId: "oauth-client-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    organizationId: "org-1",
    createdAt: new Date(),
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
        identifier: "CODE-1",
        title: "Test issue",
        url: "https://linear.app/issue/CODE-1",
        teamId: "team-1",
        team: {
          id: "team-1",
          key: "CODE",
          name: "OpenCode",
        },
      },
    },
  } satisfies AgentSessionEventWebhookPayload;

  return event;
}

function createOpencode(): OpencodeService {
  return new OpencodeService(
    createOpencodeClient({ baseUrl: "http://localhost:4096" }),
  );
}

function createSessionRepository(): SessionRepository {
  return {
    get: async () => null,
    save: async () => undefined,
    delete: async () => undefined,
    getPendingQuestion: async () => null,
    savePendingQuestion: async () => undefined,
    deletePendingQuestion: async () => undefined,
    getPendingPermission: async () => null,
    savePendingPermission: async () => undefined,
    deletePendingPermission: async () => undefined,
  };
}

function createLinear(labels: string[], errors: string[]): LinearService {
  return {
    postActivity: async () => Result.ok(undefined),
    postStageActivity: async () => Result.ok(undefined),
    postError: async (_sessionId, error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      return Result.ok(undefined);
    },
    postElicitation: async () => Result.ok(undefined),
    setExternalLink: async () => Result.ok(undefined),
    updatePlan: async () => Result.ok(undefined),
    getIssue: async () =>
      Result.ok({
        id: "issue-1",
        identifier: "CODE-1",
        title: "t",
        url: "https://linear.app",
      }),
    getIssueLabels: async () =>
      Result.ok(labels.map((name, i) => ({ id: `label-${i}`, name }))),
    getIssueAttachments: async () => Result.ok([]),
    getIssueRepositorySuggestions: async () =>
      Result.ok([
        {
          hostname: "github.com",
          repositoryFullName: "opencode-linear-agent",
          confidence: 0.91,
        },
      ]),
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({ id: "state-1", name: "Todo", type: "unstarted" }),
  };
}

describe("dispatchAgentSessionEvent", () => {
  test("short-circuits and posts actionable error when repo label missing", async () => {
    const errors: string[] = [];
    let called = false;

    await dispatchAgentSessionEvent(
      createEvent(),
      createLinear([], errors),
      createOpencode(),
      createSessionRepository(),
      { projectsPath: import.meta.dir },
      "org-1",
      async () => {
        called = true;
      },
    );

    expect(called).toBe(false);
    expect(errors[0]).toContain("Missing repository label");
    expect(errors[0]).toContain("repo:opencode-linear-agent");
    expect(errors[0]).toContain(
      "I stopped before creating any OpenCode session or worktree.",
    );
  });

  test("continues with resolved repo when label valid", async () => {
    const paths: string[] = [];

    await dispatchAgentSessionEvent(
      createEvent(),
      createLinear(["repo:opencode-linear-agent"], []),
      createOpencode(),
      createSessionRepository(),
      { projectsPath: "/tmp/projects" },
      "org-1",
      async (repoPath) => {
        paths.push(repoPath);
      },
    );

    expect(paths).toEqual(["/tmp/projects/opencode-linear-agent"]);
  });
});
