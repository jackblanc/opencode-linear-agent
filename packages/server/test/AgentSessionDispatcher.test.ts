import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import {
  OpencodeService,
  type LinearService,
  type PendingRepoSelection,
  type SessionRepository,
  type SessionState,
} from "@opencode-linear-agent/core";
import { dispatchAgentSessionEvent } from "../src/AgentSessionDispatcher";

const TEST_DIR = join(import.meta.dir, ".test-agent-dispatcher");

interface LinearCallState {
  elicitations: Array<{
    sessionId: string;
    body: string;
    signal: string;
    metadata: unknown;
  }>;
  errors: string[];
  repoLabels: Array<{ issueId: string; labelName: string }>;
}

interface RepoState {
  state: SessionState | null;
  pendingSelection: PendingRepoSelection | null;
  savedSelections: PendingRepoSelection[];
  deletedSelections: string[];
}

function createEvent(
  action: "created" | "prompted" = "created",
  body?: string,
): AgentSessionEventWebhookPayload {
  const event = {
    type: "AgentSessionEvent",
    action,
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
    promptContext: body ?? "<issue>repo label context</issue>",
  } satisfies AgentSessionEventWebhookPayload;

  return event;
}

function createOpencode(): OpencodeService {
  return new OpencodeService(
    createOpencodeClient({ baseUrl: "http://localhost:4096" }),
  );
}

function createSessionRepository(repo: RepoState): SessionRepository {
  return {
    get: async () => repo.state,
    save: async () => undefined,
    delete: async () => undefined,
    getPendingQuestion: async () => null,
    savePendingQuestion: async () => undefined,
    deletePendingQuestion: async () => undefined,
    getPendingPermission: async () => null,
    savePendingPermission: async () => undefined,
    deletePendingPermission: async () => undefined,
    getPendingRepoSelection: async () => repo.pendingSelection,
    savePendingRepoSelection: async (selection) => {
      repo.pendingSelection = selection;
      repo.savedSelections.push(selection);
    },
    deletePendingRepoSelection: async (linearSessionId) => {
      repo.deletedSelections.push(linearSessionId);
      repo.pendingSelection = null;
    },
  };
}

function createLinear(
  labels: string[],
  calls: LinearCallState,
  suggestions = [
    {
      hostname: "github.com",
      repositoryFullName: "opencode-linear-agent",
      confidence: 0.91,
    },
  ],
): LinearService {
  return {
    postActivity: async () => Result.ok(undefined),
    postStageActivity: async () => Result.ok(undefined),
    postError: async (_sessionId, error) => {
      calls.errors.push(error instanceof Error ? error.message : String(error));
      return Result.ok(undefined);
    },
    postElicitation: async (sessionId, body, signal, metadata) => {
      calls.elicitations.push({ sessionId, body, signal, metadata });
      return Result.ok(undefined);
    },
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
    getIssueRepositorySuggestions: async () => Result.ok(suggestions),
    setIssueRepoLabel: async (issueId, labelName) => {
      calls.repoLabels.push({ issueId, labelName });
      return Result.ok(undefined);
    },
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({ id: "state-1", name: "Todo", type: "unstarted" }),
  };
}

describe("dispatchAgentSessionEvent", () => {
  beforeEach(async () => {
    await mkdir(join(TEST_DIR, "opencode-linear-agent"), { recursive: true });
    await mkdir(join(TEST_DIR, "alpha"), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("posts select elicitation and saves pending repo selection when suggestions exist", async () => {
    const calls: LinearCallState = {
      elicitations: [],
      errors: [],
      repoLabels: [],
    };
    const repo: RepoState = {
      state: null,
      pendingSelection: null,
      savedSelections: [],
      deletedSelections: [],
    };
    const processed: string[] = [];

    await dispatchAgentSessionEvent(
      createEvent(),
      createLinear([], calls),
      createOpencode(),
      createSessionRepository(repo),
      {
        organizationId: "org-1",
        projectsPath: TEST_DIR,
      },
      async (_event, repoPath) => {
        processed.push(repoPath);
      },
    );

    expect(processed).toEqual([]);
    expect(calls.errors).toEqual([]);
    expect(calls.elicitations).toHaveLength(1);
    expect(calls.elicitations[0]?.signal).toBe("select");
    expect(repo.savedSelections).toHaveLength(1);
    expect(repo.savedSelections[0]?.options[0]?.labelValue).toBe(
      "repo:opencode-linear-agent",
    );
  });

  test("posts actionable error when no suggestions exist", async () => {
    const calls: LinearCallState = {
      elicitations: [],
      errors: [],
      repoLabels: [],
    };
    const repo: RepoState = {
      state: null,
      pendingSelection: null,
      savedSelections: [],
      deletedSelections: [],
    };

    await dispatchAgentSessionEvent(
      createEvent(),
      createLinear([], calls, []),
      createOpencode(),
      createSessionRepository(repo),
      {
        organizationId: "org-1",
        projectsPath: TEST_DIR,
      },
    );

    expect(calls.elicitations).toEqual([]);
    expect(calls.errors[0]).toContain("Missing repository label");
    expect(repo.savedSelections).toEqual([]);
  });

  test("uses selected repo label and starts session as created", async () => {
    const calls: LinearCallState = {
      elicitations: [],
      errors: [],
      repoLabels: [],
    };
    const repo: RepoState = {
      state: null,
      pendingSelection: {
        linearSessionId: "session-1",
        issueId: "issue-1",
        options: [
          {
            label: "opencode-linear-agent",
            labelValue: "repo:opencode-linear-agent",
            aliases: ["repo:opencode-linear-agent", "opencode-linear-agent"],
          },
        ],
        promptContext: "<issue>saved</issue>",
        createdAt: Date.now(),
      },
      savedSelections: [],
      deletedSelections: [],
    };
    const processed: Array<{ action: string; repoPath: string }> = [];

    await dispatchAgentSessionEvent(
      createEvent("prompted", "repo:opencode-linear-agent"),
      createLinear([], calls),
      createOpencode(),
      createSessionRepository(repo),
      {
        organizationId: "org-1",
        projectsPath: TEST_DIR,
      },
      async (event, repoPath) => {
        processed.push({ action: event.action, repoPath });
      },
    );

    expect(calls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
    expect(repo.deletedSelections).toEqual(["session-1"]);
    expect(processed).toEqual([
      {
        action: "created",
        repoPath: join(TEST_DIR, "opencode-linear-agent"),
      },
    ]);
  });

  test("accepts freeform repo input for pending selection", async () => {
    const calls: LinearCallState = {
      elicitations: [],
      errors: [],
      repoLabels: [],
    };
    const repo: RepoState = {
      state: null,
      pendingSelection: {
        linearSessionId: "session-1",
        issueId: "issue-1",
        options: [
          {
            label: "opencode-linear-agent",
            labelValue: "repo:opencode-linear-agent",
            aliases: ["repo:opencode-linear-agent", "opencode-linear-agent"],
          },
        ],
        promptContext: "<issue>saved</issue>",
        createdAt: Date.now(),
      },
      savedSelections: [],
      deletedSelections: [],
    };
    const processed: string[] = [];

    await dispatchAgentSessionEvent(
      createEvent("prompted", "jackblanc/opencode-linear-agent"),
      createLinear([], calls),
      createOpencode(),
      createSessionRepository(repo),
      {
        organizationId: "org-1",
        projectsPath: TEST_DIR,
      },
      async (_event, repoPath) => {
        processed.push(repoPath);
      },
    );

    expect(calls.repoLabels).toEqual([
      {
        issueId: "issue-1",
        labelName: "repo:jackblanc/opencode-linear-agent",
      },
    ]);
    expect(processed).toEqual([join(TEST_DIR, "opencode-linear-agent")]);
  });

  test("reuses stored repo directory for active prompted sessions", async () => {
    const calls: LinearCallState = {
      elicitations: [],
      errors: [],
      repoLabels: [],
    };
    const repo: RepoState = {
      state: {
        linearSessionId: "session-1",
        opencodeSessionId: "opencode-1",
        issueId: "issue-1",
        repoDirectory: "/tmp/existing-repo",
        branchName: "feature/code-1",
        workdir: "/tmp/worktree-1",
        lastActivityTime: Date.now(),
      },
      pendingSelection: null,
      savedSelections: [],
      deletedSelections: [],
    };
    const processed: Array<{ action: string; repoPath: string }> = [];

    await dispatchAgentSessionEvent(
      createEvent("prompted", "continue"),
      createLinear([], calls),
      createOpencode(),
      createSessionRepository(repo),
      {
        organizationId: "org-1",
        projectsPath: "/tmp/projects",
      },
      async (event, repoPath) => {
        processed.push({ action: event.action, repoPath });
      },
    );

    expect(processed).toEqual([
      { action: "prompted", repoPath: "/tmp/existing-repo" },
    ]);
    expect(calls.elicitations).toEqual([]);
    expect(calls.errors).toEqual([]);
  });
});
