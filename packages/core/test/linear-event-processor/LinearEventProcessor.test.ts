import { describe, test, expect } from "bun:test";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { LinearEventProcessor } from "../../src/linear-event-processor/LinearEventProcessor";
import { OpencodeService } from "../../src/opencode-service/OpencodeService";
import { SessionRepository } from "../../src/state/SessionRepository";
import type { PendingQuestion } from "../../src/state/schema";
import { TestLinearService } from "../linear-service/TestLinearService";
import { createInMemoryAgentState } from "../state/InMemoryAgentNamespace";

const defaultProjects = [
  {
    id: "project-1",
    name: "linear-agent",
    worktree: "/repos/opencode-linear-agent",
    sandboxes: [],
    time: { created: 1, updated: 1 },
  },
];

type IssueLabel = { id: string; name: string };

function createEvent(
  action: "created" | "prompted",
  promptContext = "Please help.",
): AgentSessionEventWebhookPayload {
  return {
    type: "AgentSessionEvent",
    action,
    appUserId: "app-user-1",
    oauthClientId: "oauth-client-1",
    organizationId: "org-1",
    webhookId: "webhook-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    webhookTimestamp: Date.now(),
    agentSession: {
      id: "linear-session-1",
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
        url: "https://linear.app/example/CODE-1",
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

function createPendingQuestion(): PendingQuestion {
  return {
    requestId: "qst-1",
    opencodeSessionId: "opencode-1",
    linearSessionId: "linear-session-1",
    workdir: "/tmp/workdir",
    issueId: "issue-1",
    questions: [
      {
        question: "What next?",
        header: "Choice",
        options: [
          { label: "Ship now", description: "Merge immediately" },
          { label: "Update docs", description: "Docs only" },
        ],
      },
    ],
    answers: [null],
    createdAt: Date.now(),
  };
}

function createProcessorHarness(options?: {
  projects?: typeof defaultProjects;
  labels?: IssueLabel[];
}) {
  const repository = new SessionRepository(createInMemoryAgentState());
  const linearCalls = {
    elicitations: [] as Array<{ body: string; metadata: unknown }>,
    repoLabels: [] as Array<{ issueId: string; labelName: string }>,
    errors: [] as string[],
  };
  const projects = options?.projects ?? defaultProjects;
  const linear = new TestLinearService({
    getIssueLabels: async () => Result.ok(options?.labels ?? []),
    getIssue: async () =>
      Result.ok({
        id: "issue-1",
        identifier: "CODE-1",
        branchName: "jack/code-1-linear-branch",
        title: "x",
        description: undefined,
        url: "https://linear.app",
      }),
  });
  const originalPostElicitation = linear.postElicitation.bind(linear);
  Object.defineProperty(linear, "postElicitation", {
    value: async (
      sessionId: string,
      body: string,
      signal: Parameters<TestLinearService["postElicitation"]>[2],
      metadata?: Parameters<TestLinearService["postElicitation"]>[3],
    ) => {
      linearCalls.elicitations.push({ body, metadata });
      return originalPostElicitation(sessionId, body, signal, metadata);
    },
  });
  const originalSetIssueRepoLabel = linear.setIssueRepoLabel.bind(linear);
  Object.defineProperty(linear, "setIssueRepoLabel", {
    value: async (issueId: string, labelName: string) => {
      linearCalls.repoLabels.push({ issueId, labelName });
      return originalSetIssueRepoLabel(issueId, labelName);
    },
  });
  const originalPostError = linear.postError.bind(linear);
  Object.defineProperty(linear, "postError", {
    value: async (sessionId: string, error: unknown) => {
      linearCalls.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      return originalPostError(sessionId, error);
    },
  });

  const opencode = new OpencodeService(
    createOpencodeClient({ baseUrl: "http://localhost:4096" }),
  );
  const opencodeCalls = {
    listProjects: 0,
    createWorktree: [] as Array<{ directory: string; name: string }>,
    createSession: [] as string[],
    getSession: [] as Array<{ sessionID: string; directory: string }>,
    replyQuestion: [] as Array<Array<Array<string>>>,
    prompt: [] as Array<{ workdir: string; text: string }>,
  };

  Object.defineProperty(opencode, "listProjects", {
    value: async () => {
      opencodeCalls.listProjects += 1;
      return Result.ok({ projects });
    },
  });
  Object.defineProperty(opencode, "createWorktree", {
    value: async (directory: string, name: string) => {
      opencodeCalls.createWorktree.push({ directory, name });
      return Result.ok({
        directory: "/repos/opencode-linear-agent/.worktrees/code-1",
        branch: "feature/code-1",
      });
    },
  });
  Object.defineProperty(opencode, "createSession", {
    value: async (directory: string) => {
      opencodeCalls.createSession.push(directory);
      return Result.ok({ id: "opencode-1" });
    },
  });
  Object.defineProperty(opencode, "getSession", {
    value: async (sessionID: string, directory: string) => {
      opencodeCalls.getSession.push({ sessionID, directory });
      return Result.ok({ id: sessionID });
    },
  });
  Object.defineProperty(opencode, "replyQuestion", {
    value: async (_requestId: string, answers: Array<Array<string>>) => {
      opencodeCalls.replyQuestion.push(answers);
      return Result.ok(undefined);
    },
  });
  Object.defineProperty(opencode, "prompt", {
    value: async (
      _sessionID: string,
      workdir: string,
      parts: Array<{ type: "text"; text: string }>,
    ) => {
      opencodeCalls.prompt.push({ workdir, text: parts[0]?.text ?? "" });
      return Result.ok(undefined);
    },
  });

  const processor = new LinearEventProcessor(opencode, linear, repository, {
    organizationId: "org-1",
  });

  return { repository, processor, linearCalls, opencodeCalls };
}

describe("LinearEventProcessor.process", () => {
  test("maps pending question replies to canonical option labels", async () => {
    const harness = createProcessorHarness();
    await harness.repository.save({
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/workdir",
      lastActivityTime: Date.now(),
    });
    await harness.repository.savePendingQuestion(createPendingQuestion());

    await harness.processor.process(
      createEvent("prompted", "Merge immediately"),
    );

    expect(harness.opencodeCalls.replyQuestion).toEqual([[["Ship now"]]]);
    expect(
      await harness.repository.getPendingQuestion("linear-session-1"),
    ).toBeNull();
  });

  test("prompts for project selection when repo label is missing", async () => {
    const harness = createProcessorHarness();

    await harness.processor.process(createEvent("created"));

    const pending =
      await harness.repository.getPendingRepoSelection("linear-session-1");
    expect(pending?.options).toEqual([
      {
        label: "linear-agent",
        projectId: "project-1",
        worktree: "/repos/opencode-linear-agent",
        repoLabel: "repo:opencode-linear-agent",
        aliases: ["linear-agent", "opencode-linear-agent"],
      },
    ]);
    expect(harness.linearCalls.elicitations).toHaveLength(1);
  });

  test("uses selected project and saves canonical project id", async () => {
    const harness = createProcessorHarness();
    await harness.repository.savePendingRepoSelection({
      linearSessionId: "linear-session-1",
      issueId: "issue-1",
      options: [
        {
          label: "linear-agent",
          projectId: "project-1",
          worktree: "/repos/opencode-linear-agent",
          repoLabel: "repo:opencode-linear-agent",
          aliases: ["linear-agent", "opencode-linear-agent"],
        },
      ],
      promptContext: "Saved context",
      createdAt: Date.now(),
    });

    await harness.processor.process(
      createEvent("prompted", "repo:opencode-linear-agent"),
    );

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
    expect(harness.opencodeCalls.createWorktree).toEqual([
      {
        directory: "/repos/opencode-linear-agent",
        name: "linear-s-jack/code-1-linear-branch",
      },
    ]);
    expect(harness.opencodeCalls.listProjects).toBe(0);
    expect(
      await harness.repository.getPendingRepoSelection("linear-session-1"),
    ).toBeNull();
    expect(await harness.repository.get("linear-session-1")).toEqual({
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/repos/opencode-linear-agent/.worktrees/code-1",
      lastActivityTime: expect.any(Number),
    });
  });

  test("reuses stored project session for prompted follow-ups", async () => {
    const harness = createProcessorHarness();
    await harness.repository.save({
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/existing-worktree",
      lastActivityTime: Date.now(),
    });

    await harness.processor.process(createEvent("prompted", "continue"));

    expect(harness.opencodeCalls.createWorktree).toEqual([]);
    expect(harness.opencodeCalls.getSession).toEqual([
      { sessionID: "opencode-1", directory: "/tmp/existing-worktree" },
    ]);
    expect(harness.opencodeCalls.prompt).toEqual([
      { workdir: "/tmp/existing-worktree", text: "continue" },
    ]);
    expect(harness.opencodeCalls.listProjects).toBe(0);
  });

  test("matches exact repo label in pending selection", async () => {
    const harness = createProcessorHarness();
    await harness.repository.savePendingRepoSelection({
      linearSessionId: "linear-session-1",
      issueId: "issue-1",
      options: [
        {
          label: "linear-agent",
          projectId: "project-1",
          worktree: "/repos/opencode-linear-agent",
          repoLabel: "repo:opencode-linear-agent",
          aliases: ["linear-agent", "opencode-linear-agent"],
        },
      ],
      promptContext: "Saved context",
      createdAt: Date.now(),
    });

    await harness.processor.process(
      createEvent("prompted", "repo:opencode-linear-agent"),
    );

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
  });

  test("matches org-qualified repo label in pending selection", async () => {
    const harness = createProcessorHarness();
    await harness.repository.savePendingRepoSelection({
      linearSessionId: "linear-session-1",
      issueId: "issue-1",
      options: [
        {
          label: "linear-agent",
          projectId: "project-1",
          worktree: "/repos/opencode-linear-agent",
          repoLabel: "repo:opencode-linear-agent",
          aliases: ["linear-agent", "opencode-linear-agent"],
        },
      ],
      promptContext: "Saved context",
      createdAt: Date.now(),
    });

    await harness.processor.process(
      createEvent("prompted", "repo:jackblanc/opencode-linear-agent"),
    );

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
  });

  test("matches plain repository name in pending selection", async () => {
    const harness = createProcessorHarness();
    await harness.repository.savePendingRepoSelection({
      linearSessionId: "linear-session-1",
      issueId: "issue-1",
      options: [
        {
          label: "linear-agent",
          projectId: "project-1",
          worktree: "/repos/opencode-linear-agent",
          repoLabel: "repo:opencode-linear-agent",
          aliases: ["linear-agent", "opencode-linear-agent"],
        },
      ],
      promptContext: "Saved context",
      createdAt: Date.now(),
    });

    await harness.processor.process(
      createEvent("prompted", "opencode-linear-agent"),
    );

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
  });

  test("re-prompts on invalid pending selection reply", async () => {
    const harness = createProcessorHarness();
    await harness.repository.savePendingRepoSelection({
      linearSessionId: "linear-session-1",
      issueId: "issue-1",
      options: [
        {
          label: "linear-agent",
          projectId: "project-1",
          worktree: "/repos/opencode-linear-agent",
          repoLabel: "repo:opencode-linear-agent",
          aliases: ["linear-agent", "opencode-linear-agent"],
        },
      ],
      promptContext: "Saved context",
      createdAt: Date.now(),
    });

    await harness.processor.process(createEvent("prompted", "wrong repo"));

    expect(harness.linearCalls.elicitations).toHaveLength(1);
    expect(harness.linearCalls.elicitations[0]?.body).toContain(
      "I couldn't use `wrong repo`",
    );
    expect(harness.linearCalls.repoLabels).toEqual([]);
  });

  test("matches issue repo label with organization to project by repo name", async () => {
    const harness = createProcessorHarness({
      labels: [{ id: "label-1", name: "repo:jackblanc/opencode-linear-agent" }],
    });

    await harness.processor.process(createEvent("created"));

    expect(harness.opencodeCalls.createWorktree).toEqual([
      {
        directory: "/repos/opencode-linear-agent",
        name: "linear-s-jack/code-1-linear-branch",
      },
    ]);
  });

  test("includes unmatched repo label in no-match prompt", async () => {
    const harness = createProcessorHarness({
      labels: [{ id: "label-1", name: "repo:jackblanc/missing-repo" }],
    });

    await harness.processor.process(createEvent("created"));

    expect(harness.linearCalls.elicitations).toHaveLength(1);
    expect(harness.linearCalls.elicitations[0]?.body).toContain(
      "No OpenCode project matches `repo:jackblanc/missing-repo`.",
    );
  });
});
