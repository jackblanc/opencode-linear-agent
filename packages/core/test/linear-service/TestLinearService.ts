import {
  AgentActivityPayload,
  AgentSessionPayload,
  type LinearRequest,
} from "@linear/sdk";
import { Result } from "better-result";
import { LinearService } from "../../src/linear-service/LinearService";
import type { IssueState } from "../../src/linear-service/types";

const noopRequest: LinearRequest = async () => {
  throw new Error("unused in tests");
};

function activityPayload(id = "activity-1") {
  return new AgentActivityPayload(noopRequest, {
    __typename: "AgentActivityPayload",
    lastSyncId: 1,
    success: true,
    agentActivity: { __typename: "AgentActivity", id },
  });
}

function sessionPayload(id = "session-1") {
  return new AgentSessionPayload(noopRequest, {
    __typename: "AgentSessionPayload",
    lastSyncId: 1,
    success: true,
    agentSession: { __typename: "AgentSession", id },
  });
}

type Overrides = Partial<{
  postActivity: LinearService["postActivity"];
  postStageActivity: LinearService["postStageActivity"];
  postError: LinearService["postError"];
  postElicitation: LinearService["postElicitation"];
  setExternalLink: LinearService["setExternalLink"];
  updatePlan: LinearService["updatePlan"];
  getIssue: LinearService["getIssue"];
  getIssueLabels: LinearService["getIssueLabels"];
  getIssueAttachments: LinearService["getIssueAttachments"];
  getIssueRepositorySuggestions: LinearService["getIssueRepositorySuggestions"];
  setIssueRepoLabel: LinearService["setIssueRepoLabel"];
  getIssueAgentSessionIds: LinearService["getIssueAgentSessionIds"];
  moveIssueToInProgress: LinearService["moveIssueToInProgress"];
  getIssueState: LinearService["getIssueState"];
}>;

export class TestLinearService extends LinearService {
  constructor(private readonly overrides: Overrides = {}) {
    super("fake_access_token");
  }

  override async postActivity(
    sessionId: string,
    content: Parameters<LinearService["postActivity"]>[1],
    ephemeral?: boolean,
  ) {
    return (
      this.overrides.postActivity?.(sessionId, content, ephemeral) ??
      Result.ok(activityPayload(sessionId))
    );
  }

  override async postStageActivity(
    sessionId: string,
    stage: Parameters<LinearService["postStageActivity"]>[1],
    details?: string,
  ) {
    return (
      this.overrides.postStageActivity?.(sessionId, stage, details) ??
      Result.ok(activityPayload(sessionId))
    );
  }

  override async postError(sessionId: string, error: unknown) {
    return (
      this.overrides.postError?.(sessionId, error) ??
      Result.ok(activityPayload(sessionId))
    );
  }

  override async postElicitation(
    sessionId: string,
    body: string,
    signal: Parameters<LinearService["postElicitation"]>[2],
    metadata?: Parameters<LinearService["postElicitation"]>[3],
  ) {
    return (
      this.overrides.postElicitation?.(sessionId, body, signal, metadata) ??
      Result.ok(activityPayload(sessionId))
    );
  }

  override async setExternalLink(sessionId: string, url: string) {
    return (
      this.overrides.setExternalLink?.(sessionId, url) ??
      Result.ok(sessionPayload(sessionId))
    );
  }

  override async updatePlan(
    sessionId: string,
    plan: Parameters<LinearService["updatePlan"]>[1],
  ) {
    return (
      this.overrides.updatePlan?.(sessionId, plan) ??
      Result.ok(sessionPayload(sessionId))
    );
  }

  override async getIssue(issueId: string) {
    return (
      this.overrides.getIssue?.(issueId) ??
      Result.ok({
        id: issueId,
        identifier: "CODE-1",
        branchName: "feature/code-1",
        title: "x",
        description: undefined,
        url: "https://linear.app",
      })
    );
  }

  override async getIssueLabels(issueId: string) {
    return this.overrides.getIssueLabels?.(issueId) ?? Result.ok([]);
  }

  override async getIssueAttachments(issueId: string) {
    return this.overrides.getIssueAttachments?.(issueId) ?? Result.ok([]);
  }

  override async getIssueRepositorySuggestions(
    issueId: string,
    agentSessionId: string,
    candidates: Parameters<LinearService["getIssueRepositorySuggestions"]>[2],
  ) {
    return (
      this.overrides.getIssueRepositorySuggestions?.(
        issueId,
        agentSessionId,
        candidates,
      ) ?? Result.ok([])
    );
  }

  override async setIssueRepoLabel(issueId: string, labelName: string) {
    return (
      this.overrides.setIssueRepoLabel?.(issueId, labelName) ??
      Result.ok(undefined)
    );
  }

  override async getIssueAgentSessionIds(issueId: string) {
    return this.overrides.getIssueAgentSessionIds?.(issueId) ?? Result.ok([]);
  }

  override async moveIssueToInProgress(issueId: string) {
    return (
      this.overrides.moveIssueToInProgress?.(issueId) ?? Result.ok(undefined)
    );
  }

  override async getIssueState(issueId: string) {
    const state: IssueState = {
      id: "state-1",
      name: "Started",
      type: "started",
    };

    return this.overrides.getIssueState?.(issueId) ?? Result.ok(state);
  }
}
