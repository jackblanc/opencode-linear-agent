import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import { Result } from "better-result";

import type { Logger } from "../utils/logger";
import type {
  ActivityContent,
  IssueState,
  PlanItem,
  ProcessingStage,
  SignalMetadata,
  ElicitationSignal,
  IssueRepositoryCandidate,
  IssueRepositorySuggestion,
} from "./types";

import { Log } from "../utils/logger";
import { mapLinearError } from "./errors";
import { STAGE_MESSAGES } from "./types";

interface IssueCommentPage {
  nodes: Array<{ agentSessionId?: string | null }>;
  pageInfo: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
}

interface IssueRepositorySuggestionsQuery {
  issueRepositorySuggestions: {
    suggestions: IssueRepositorySuggestion[];
  };
}

interface IssueLabelCreateMutation {
  issueLabelCreate: {
    success: boolean;
    issueLabel?: {
      id: string;
    } | null;
  };
}

interface LinearLabelPage {
  nodes: Array<{ id: string; name: string }>;
  pageInfo: { hasNextPage: boolean };
  fetchNext: () => Promise<LinearLabelPage>;
}

async function collectTeamLabels(team: {
  labels: () => Promise<LinearLabelPage>;
}): Promise<Array<{ id: string; name: string }>> {
  const first = await team.labels();
  const labels = [...first.nodes];
  let page = first;

  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    labels.push(...page.nodes);
  }

  return labels;
}

async function collectIssueAgentSessionIds(
  fetchPage: (after?: string) => Promise<IssueCommentPage>,
): Promise<string[]> {
  const ids = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const comments = await fetchPage(after);

    for (const comment of comments.nodes) {
      if (comment.agentSessionId) {
        ids.add(comment.agentSessionId);
      }
    }

    if (!comments.pageInfo.hasNextPage || !comments.pageInfo.endCursor) {
      break;
    }

    after = comments.pageInfo.endCursor;
  }

  return Array.from(ids);
}

/**
 * Map Linear's WorkflowState.type (typed as string in SDK) to our narrower union type.
 *
 * The Linear SDK types state.type as `string`, but the documented values are:
 * triage, backlog, unstarted, started, completed, canceled.
 * Unknown values are preserved as `unknown` so callers can handle them safely.
 *
 * Note: "Icebox" is not a separate type - it's a custom state name with type "backlog".
 */
function toIssueStateType(value: string): IssueState["type"] {
  switch (value) {
    case "triage":
    case "backlog":
    case "unstarted":
    case "started":
    case "completed":
    case "canceled":
      return value;
    default:
      return "unknown";
  }
}

/**
 * Maps elicitation signals to Linear's AgentActivitySignal
 *
 * Only auth and select are valid agent-to-human signals per Linear docs.
 */
function mapElicitationSignal(signal: ElicitationSignal): AgentActivitySignal | undefined {
  switch (signal) {
    case "auth":
      return AgentActivitySignal.Auth;
    case "select":
      return AgentActivitySignal.Select;
    default:
      return undefined;
  }
}

export class LinearService {
  private readonly client: LinearClient;
  private readonly log: Logger;

  constructor(accessToken: string) {
    this.client = new LinearClient({ accessToken });
    this.log = Log.create({ service: "linear" });
  }

  // ─────────────────────────────────────────────────────────────
  // Agent Activity Methods
  // ─────────────────────────────────────────────────────────────
  async postActivity(sessionId: string, content: ActivityContent, ephemeral = false) {
    return Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content,
          ephemeral,
        }),
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to send activity", {
          activityType: content.type,
          sessionId,
          ephemeral,
          error,
        });
        return error;
      },
    });
  }

  async postStageActivity(sessionId: string, stage: ProcessingStage, details?: string) {
    const baseMessage = STAGE_MESSAGES[stage];
    const body = details ? `${baseMessage}\n\n${details}` : baseMessage;

    return Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content: { type: "thought", body },
          ephemeral: true,
        }),
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to send stage activity", {
          processingStage: stage,
          sessionId,
          error: error,
        });
        return error;
      },
    });
  }

  async postError(sessionId: string, error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const truncatedStack = errorStack ? errorStack.split("\n").slice(0, 20).join("\n") : undefined;

    const errorBody = truncatedStack
      ? `**Error:** ${errorMessage}\n\n**Stack trace:**\n\`\`\`\n${truncatedStack}\n\`\`\``
      : `**Error:** ${errorMessage}`;

    return Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content: { type: "error", body: errorBody },
          ephemeral: false,
        }),
      catch: (cause: unknown) => {
        const mapped = mapLinearError(cause);
        this.log.error("Failed to report error to Linear", {
          sessionId,
          originalError: errorMessage,
          reportError: mapped,
        });
        return mapped;
      },
    });
  }

  async postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ) {
    return Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content: {
            type: "elicitation",
            body,
          },
          signal: mapElicitationSignal(signal),
          signalMetadata: metadata,
          ephemeral: false,
        }),
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to send elicitation", {
          sessionId,
          signal,
          error,
        });
        return error;
      },
    });
  }

  async setExternalLink(sessionId: string, url: string) {
    return Result.tryPromise({
      try: async () => {
        const agentSession = await this.client.agentSession(sessionId);
        return agentSession.update({ externalLink: url });
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to set external link", {
          sessionId,
          url,
          error,
        });
        return error;
      },
    });
  }

  async updatePlan(sessionId: string, plan: PlanItem[]) {
    return Result.tryPromise({
      try: async () => {
        const agentSession = await this.client.agentSession(sessionId);
        return agentSession.update({ plan });
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to update plan", {
          sessionId,
          planItemCount: plan.length,
          error,
        });
        return error;
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  async getIssue(issueId: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        return {
          id: issue.id,
          identifier: issue.identifier,
          branchName: issue.branchName,
          title: issue.title,
          description: issue.description ?? undefined,
          url: issue.url,
        };
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to get issue", {
          issueId,
          error,
        });
        return error;
      },
    });
  }

  async getIssueLabels(issueId: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const labels = await issue.labels();
        return labels.nodes.map((label) => ({
          id: label.id,
          name: label.name,
        }));
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to get issue labels", {
          issueId,
          error,
        });
        return error;
      },
    });
  }

  async getIssueAttachments(issueId: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const attachments = await issue.attachments();
        return attachments.nodes.map((attachment) => ({
          id: attachment.id,
          url: attachment.url,
          title: attachment.title,
        }));
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to get issue attachments", {
          issueId,
          error,
        });
        return error;
      },
    });
  }

  async getIssueRepositorySuggestions(
    issueId: string,
    agentSessionId: string,
    candidates: IssueRepositoryCandidate[],
  ) {
    return Result.tryPromise({
      try: async () => {
        const response = await this.client.client.rawRequest<
          IssueRepositorySuggestionsQuery,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
          {
            issueId: string;
            agentSessionId: string;
            candidateRepositories: IssueRepositoryCandidate[];
          }
        >(
          `query IssueRepositorySuggestions($issueId: String!, $agentSessionId: String!, $candidateRepositories: [RepositoryInput!]!) {
            issueRepositorySuggestions(
              issueId: $issueId
              agentSessionId: $agentSessionId
              candidateRepositories: $candidateRepositories
            ) {
              suggestions {
                repositoryFullName
                hostname
                confidence
              }
            }
          }`,
          {
            issueId,
            agentSessionId,
            candidateRepositories: candidates,
          },
        );

        if (!response.data) {
          return [];
        }

        return response.data.issueRepositorySuggestions.suggestions;
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to get issue repository suggestions", {
          issueId,
          agentSessionId,
          candidateCount: candidates.length,
          error,
        });
        return error;
      },
    });
  }

  async setIssueRepoLabel(issueId: string, labelName: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const team = await issue.team;

        if (!team) {
          throw new Error("Issue has no associated team");
        }

        const issueLabels = await issue.labels();
        const teamLabels = await collectTeamLabels(team);
        let repoLabelId = teamLabels.find(
          (label) => label.name.toLowerCase() === labelName.toLowerCase(),
        )?.id;

        if (!repoLabelId) {
          const response = await this.client.client.rawRequest<
            IssueLabelCreateMutation,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
            { input: { name: string; teamId: string } }
          >(
            `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
              issueLabelCreate(input: $input) {
                success
                issueLabel {
                  id
                }
              }
            }`,
            {
              input: {
                name: labelName,
                teamId: team.id,
              },
            },
          );

          repoLabelId = response.data?.issueLabelCreate.issueLabel?.id;

          if (!repoLabelId) {
            throw new Error(`Failed to create repo label ${labelName}`);
          }
        }

        const labelIds = issueLabels.nodes
          .filter((label) => !label.name.startsWith("repo:"))
          .map((label) => label.id);

        await issue.update({
          labelIds: [...labelIds, repoLabelId],
        });
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to set repo label on issue", {
          issueId,
          labelName,
          error,
        });
        return error;
      },
    });
  }

  async getIssueAgentSessionIds(issueId: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        return collectIssueAgentSessionIds(async (after) =>
          issue.comments({
            after,
            first: 250,
            includeArchived: true,
          }),
        );
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to get issue agent sessions", {
          issueId,
          error,
        });
        return error;
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Update Methods
  // ─────────────────────────────────────────────────────────────

  async moveIssueToInProgress(issueId: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const state = await issue.state;

        if (!state) {
          throw new Error("Issue has no workflow state");
        }

        const stateType = toIssueStateType(state.type);
        if (stateType !== "unstarted") {
          this.log.info("Skipping issue auto-transition", {
            issueId,
            stateId: state.id,
            stateName: state.name,
            stateType,
          });
          return;
        }

        const team = await issue.team;

        if (!team) {
          throw new Error("Issue has no associated team");
        }

        const states = await team.states({
          filter: { type: { eq: "started" } },
        });

        if (states.nodes.length === 0) {
          throw new Error("Team has no started workflow states");
        }

        const sortedStates = states.nodes.toSorted((a, b) => a.position - b.position);
        const inProgressState = sortedStates[0];

        if (!inProgressState) {
          this.log.warn("No In Progress state found", { issueId });
          return;
        }

        this.log.info("Moving issue to first started state", {
          issueId,
          fromStateId: state.id,
          fromStateName: state.name,
          stateId: inProgressState.id,
          stateName: inProgressState.name,
        });

        await issue.update({ stateId: inProgressState.id });
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to move issue to In Progress", {
          issueId,
          error,
        });
        return error;
      },
    });
  }

  async getIssueState(issueId: string) {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const state = await issue.state;

        if (!state) {
          throw new Error("Issue has no workflow state");
        }

        return {
          id: state.id,
          name: state.name,
          type: toIssueStateType(state.type),
        };
      },
      catch: (cause: unknown) => {
        const error = mapLinearError(cause);
        this.log.error("Failed to get issue state", {
          issueId,
          error,
        });
        return error;
      },
    });
  }
}
