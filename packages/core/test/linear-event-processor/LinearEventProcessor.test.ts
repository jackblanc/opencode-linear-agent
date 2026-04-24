import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { QuestionRequest } from "@opencode-ai/sdk/v2";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { describe, test, expect } from "vitest";

import { KvIoError } from "../../src/kv/errors";
import { LinearEventProcessor } from "../../src/linear-event-processor/LinearEventProcessor";
import { OpencodeService } from "../../src/opencode-service/OpencodeService";
import { saveSessionState } from "../../src/state/session-state";
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
  sessionId = "linear-session-1",
): AgentSessionEventWebhookPayload {
  const event: AgentSessionEventWebhookPayload = {
    type: "AgentSessionEvent",
    action,
    appUserId: "app-user-1",
    oauthClientId: "oauth-client-1",
    organizationId: "org-1",
    webhookId: "webhook-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    webhookTimestamp: Date.now(),
    agentSession: {
      id: sessionId,
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

  if (action === "prompted") {
    event.agentActivity = {
      id: "activity-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      agentSessionId: sessionId,
      sourceCommentId: "comment-1",
      userId: "user-1",
      signal: null,
      signalMetadata: null,
      content: {
        type: "prompt",
        body: promptContext,
      },
      user: {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        url: "https://linear.app/test",
      },
    };
  }

  return event;
}

function createPendingQuestion(questions?: QuestionRequest["questions"]): QuestionRequest {
  return {
    id: "que-1",
    sessionID: "opencode-1",
    questions: questions ?? [
      {
        question: "What next?",
        header: "Choice",
        options: [
          { label: "Ship now", description: "Merge immediately" },
          { label: "Update docs", description: "Docs only" },
        ],
      },
    ],
  };
}

function createProcessorHarness(options?: {
  projects?: typeof defaultProjects;
  labels?: IssueLabel[];
  pendingQuestions?: QuestionRequest[];
  questionReplyError?: Error;
}) {
  const agentState = createInMemoryAgentState();
  const linearCalls: {
    elicitations: Array<{ body: string; metadata: unknown }>;
    repoLabels: Array<{ issueId: string; labelName: string }>;
    errors: string[];
  } = {
    elicitations: [] satisfies Array<{ body: string; metadata: unknown }>,
    repoLabels: [] satisfies Array<{ issueId: string; labelName: string }>,
    errors: [] satisfies string[],
  };
  const projects = options?.projects ?? defaultProjects;
  const linear = new TestLinearService({
    getIssueLabels: async () => Promise.resolve(Result.ok(options?.labels ?? [])),
    getIssue: async () =>
      Promise.resolve(
        Result.ok({
          id: "issue-1",
          identifier: "CODE-1",
          branchName: "jack/code-1-linear-branch",
          title: "x",
          description: undefined,
          url: "https://linear.app",
        }),
      ),
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
      return Promise.resolve(originalPostElicitation(sessionId, body, signal, metadata));
    },
  });
  const originalSetIssueRepoLabel = linear.setIssueRepoLabel.bind(linear);
  Object.defineProperty(linear, "setIssueRepoLabel", {
    value: async (issueId: string, labelName: string) => {
      linearCalls.repoLabels.push({ issueId, labelName });
      return Promise.resolve(originalSetIssueRepoLabel(issueId, labelName));
    },
  });
  const originalPostError = linear.postError.bind(linear);
  Object.defineProperty(linear, "postError", {
    value: async (sessionId: string, error: unknown) => {
      linearCalls.errors.push(error instanceof Error ? error.message : String(error));
      return Promise.resolve(originalPostError(sessionId, error));
    },
  });

  const opencode = new OpencodeService(createOpencodeClient({ baseUrl: "http://localhost:4096" }));
  const opencodeCalls: {
    listProjects: number;
    listPendingQuestions: string[];
    createWorktree: Array<{ directory: string; branchName: string | null; issueId?: string }>;
    createSession: string[];
    getSession: Array<{ sessionID: string; directory: string }>;
    replyQuestion: Array<Array<Array<string>>>;
    prompt: Array<{ workdir: string; text: string }>;
  } = {
    listProjects: 0,
    listPendingQuestions: [],
    createWorktree: [],
    createSession: [],
    getSession: [],
    replyQuestion: [],
    prompt: [],
  };
  let createdSessions = 0;

  Object.defineProperty(opencode, "listProjects", {
    value: () => {
      opencodeCalls.listProjects += 1;
      return Result.ok({ projects });
    },
  });
  Object.defineProperty(opencode, "createWorktree", {
    value: async (directory: string, branchName: string | null, issueId?: string) => {
      opencodeCalls.createWorktree.push({ directory, branchName, issueId });
      return Promise.resolve(
        Result.ok({
          directory: "/repos/opencode-linear-agent/.workspaces/workspace-1",
          branch: "opencode/jack-code-1-linear-branch",
        }),
      );
    },
  });
  Object.defineProperty(opencode, "createSession", {
    value: async (directory: string) => {
      createdSessions += 1;
      opencodeCalls.createSession.push(directory);
      return Promise.resolve(Result.ok({ id: `opencode-${createdSessions}` }));
    },
  });
  Object.defineProperty(opencode, "getSession", {
    value: async (sessionID: string, directory: string) => {
      opencodeCalls.getSession.push({ sessionID, directory });
      return Promise.resolve(Result.ok({ id: sessionID }));
    },
  });
  Object.defineProperty(opencode, "listPendingQuestions", {
    value: async (directory?: string) => {
      opencodeCalls.listPendingQuestions.push(directory ?? "");
      return Promise.resolve(Result.ok(options?.pendingQuestions ?? []));
    },
  });
  Object.defineProperty(opencode, "replyQuestion", {
    value: async (_requestId: string, answers: Array<Array<string>>) => {
      opencodeCalls.replyQuestion.push(answers);
      if (options?.questionReplyError) {
        return Promise.resolve(Result.err(options.questionReplyError));
      }
      return Promise.resolve(Result.ok(undefined));
    },
  });
  Object.defineProperty(opencode, "prompt", {
    value: async (
      _sessionID: string,
      workdir: string,
      parts: Array<{ type: "text"; text: string }>,
    ) => {
      opencodeCalls.prompt.push({ workdir, text: parts[0]?.text ?? "" });
      return Promise.resolve(Result.ok(undefined));
    },
  });

  const processor = new LinearEventProcessor(agentState, opencode, linear, {
    organizationId: "org-1",
  });

  return { agentState, processor, linear, linearCalls, opencodeCalls };
}

describe("LinearEventProcessor.process", () => {
  test("treats prompts as free-form replies when OpenCode has a pending question", async () => {
    const harness = createProcessorHarness({ pendingQuestions: [createPendingQuestion()] });
    await saveSessionState(harness.agentState, {
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/workdir",
      lastActivityTime: Date.now(),
    });
    await harness.processor.process(createEvent("prompted", "Please choose whichever is safer"));

    expect(harness.opencodeCalls.replyQuestion).toEqual([[["Please choose whichever is safer"]]]);
    expect((await harness.agentState.question.get("linear-session-1")).isErr()).toBe(true);
  });

  test("maps selected pending question options using OpenCode question state", async () => {
    const harness = createProcessorHarness({ pendingQuestions: [createPendingQuestion()] });
    await saveSessionState(harness.agentState, {
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/workdir",
      lastActivityTime: Date.now(),
    });
    await harness.processor.process(createEvent("prompted", "Merge immediately"));

    expect(harness.opencodeCalls.replyQuestion).toEqual([[["Ship now"]]]);
  });

  test("collects multi-question replies before replying to OpenCode", async () => {
    const question = createPendingQuestion([
      {
        question: "First?",
        header: "First",
        options: [
          { label: "Alpha", description: "Option A" },
          { label: "Beta", description: "Option B" },
        ],
      },
      {
        question: "Second?",
        header: "Second",
        options: [
          { label: "One", description: "Option 1" },
          { label: "Two", description: "Option 2" },
        ],
      },
    ]);
    const harness = createProcessorHarness({ pendingQuestions: [question] });
    await saveSessionState(harness.agentState, {
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/workdir",
      lastActivityTime: Date.now(),
    });

    await harness.processor.process(createEvent("prompted", "Option A"));
    expect(harness.opencodeCalls.replyQuestion).toEqual([]);

    await harness.processor.process(createEvent("prompted", "custom second answer"));
    expect(harness.opencodeCalls.replyQuestion).toEqual([[["Alpha"], ["custom second answer"]]]);
  });

  test("does not clear partial question state when OpenCode reply fails", async () => {
    const harness = createProcessorHarness({
      pendingQuestions: [createPendingQuestion()],
      questionReplyError: new Error("reply failed"),
    });
    await saveSessionState(harness.agentState, {
      linearSessionId: "linear-session-1",
      opencodeSessionId: "opencode-1",
      organizationId: "org-1",
      issueId: "issue-1",
      projectId: "project-1",
      branchName: "feature/code-1",
      workdir: "/tmp/workdir",
      lastActivityTime: Date.now(),
    });

    await harness.processor.process(createEvent("prompted", "Merge immediately"));

    const pending = await harness.agentState.question.get("linear-session-1");
    expect(pending.isOk()).toBe(true);
    expect(harness.linearCalls.errors).toEqual(["reply failed"]);
  });

  test("prompts for project selection when repo label is missing", async () => {
    const harness = createProcessorHarness();

    await harness.processor.process(createEvent("created"));

    const pending = await harness.agentState.repoSelection.get("linear-session-1");
    expect(Result.isOk(pending)).toBe(true);
    if (Result.isError(pending)) {
      return;
    }

    expect(pending.value.options).toEqual([
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
    await harness.agentState.repoSelection.put("linear-session-1", {
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

    await harness.processor.process(createEvent("prompted", "repo:opencode-linear-agent"));

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
    expect(harness.opencodeCalls.createWorktree).toEqual([
      {
        directory: "/repos/opencode-linear-agent",
        branchName: "jack/code-1-linear-branch",
        issueId: "issue-1",
      },
    ]);
    expect(harness.opencodeCalls.createSession).toEqual([
      "/repos/opencode-linear-agent/.workspaces/workspace-1",
    ]);
    expect(harness.opencodeCalls.listProjects).toBe(0);
    expect((await harness.agentState.repoSelection.get("linear-session-1")).isErr()).toBe(true);
    const saved = await harness.agentState.session.get("linear-session-1");
    expect(Result.isOk(saved)).toBe(true);
    if (Result.isError(saved)) {
      return;
    }

    expect(saved.value.linearSessionId).toBe("linear-session-1");
    expect(saved.value.opencodeSessionId).toBe("opencode-1");
    expect(saved.value.organizationId).toBe("org-1");
    expect(saved.value.issueId).toBe("issue-1");
    expect(saved.value.projectId).toBe("project-1");
    expect(saved.value.branchName).toBe("opencode/jack-code-1-linear-branch");
    expect(saved.value.workdir).toBe("/repos/opencode-linear-agent/.workspaces/workspace-1");
    expect(typeof saved.value.lastActivityTime).toBe("number");
  });

  test("reuses stored project session for prompted follow-ups", async () => {
    const harness = createProcessorHarness();
    await saveSessionState(harness.agentState, {
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
    await harness.agentState.repoSelection.put("linear-session-1", {
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

    await harness.processor.process(createEvent("prompted", "repo:opencode-linear-agent"));

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
  });

  test("matches org-qualified repo label in pending selection", async () => {
    const harness = createProcessorHarness();
    await harness.agentState.repoSelection.put("linear-session-1", {
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
    await harness.agentState.repoSelection.put("linear-session-1", {
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

    await harness.processor.process(createEvent("prompted", "opencode-linear-agent"));

    expect(harness.linearCalls.repoLabels).toEqual([
      { issueId: "issue-1", labelName: "repo:opencode-linear-agent" },
    ]);
  });

  test("re-prompts on invalid pending selection reply", async () => {
    const harness = createProcessorHarness();
    await harness.agentState.repoSelection.put("linear-session-1", {
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
    expect(harness.linearCalls.elicitations[0]?.body).toContain("I couldn't use `wrong repo`");
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
        branchName: "jack/code-1-linear-branch",
        issueId: "issue-1",
      },
    ]);
  });

  test("reuses issue workspace for a second Linear session on the same issue", async () => {
    const harness = createProcessorHarness({
      labels: [{ id: "label-1", name: "repo:opencode-linear-agent" }],
    });

    await harness.processor.process(createEvent("created", "Please help.", "linear-session-1"));
    await harness.processor.process(createEvent("created", "Please help.", "linear-session-2"));

    expect(harness.opencodeCalls.createWorktree).toHaveLength(1);
    expect(harness.opencodeCalls.createSession).toEqual([
      "/repos/opencode-linear-agent/.workspaces/workspace-1",
      "/repos/opencode-linear-agent/.workspaces/workspace-1",
    ]);

    const saved = await harness.agentState.session.get("linear-session-2");
    expect(Result.isOk(saved)).toBe(true);
    if (Result.isOk(saved)) {
      expect(saved.value.opencodeSessionId).toBe("opencode-2");
      expect(saved.value.workdir).toBe("/repos/opencode-linear-agent/.workspaces/workspace-1");
    }
  });

  test("reuses stored workspace branch when later issue fetch has no branch", async () => {
    const harness = createProcessorHarness({
      labels: [{ id: "label-1", name: "repo:opencode-linear-agent" }],
    });

    await harness.processor.process(createEvent("created", "Please help.", "linear-session-1"));

    Object.defineProperty(harness.linear, "getIssue", {
      value: async () =>
        Promise.resolve(
          Result.ok({
            id: "issue-1",
            identifier: "CODE-1",
            branchName: undefined,
            title: "x",
            description: undefined,
            url: "https://linear.app",
          }),
        ),
    });

    await harness.processor.process(createEvent("created", "Please help.", "linear-session-2"));

    const saved = await harness.agentState.session.get("linear-session-2");
    expect(Result.isOk(saved)).toBe(true);
    if (Result.isOk(saved)) {
      expect(saved.value.branchName).toBe("opencode/jack-code-1-linear-branch");
    }
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

  test("posts one error when project startup session lookup fails", async () => {
    const harness = createProcessorHarness({
      labels: [{ id: "label-1", name: "repo:opencode-linear-agent" }],
    });
    const error = new KvIoError({ path: "session", operation: "read", reason: "disk full" });

    Object.defineProperty(harness.agentState.session, "get", {
      value: async () => {
        return Promise.resolve(Result.err(error));
      },
    });

    await harness.processor.process(createEvent("created"));

    expect(harness.linearCalls.errors).toEqual([error.message]);
  });
});
