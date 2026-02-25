import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import { Result } from "better-result";
import type {
  LinearService,
  LinearIssue,
  LinearLabel,
  LinearAttachment,
  ElicitationSignal,
} from "./LinearService";
import type {
  ActivityContent,
  IssueState,
  PlanItem,
  ProcessingStage,
  SignalMetadata,
} from "./types";
import { STAGE_MESSAGES } from "./types";
import { Log, type Logger } from "../logger";
import type { LinearServiceError } from "../errors";
import { mapLinearError } from "../errors";

interface IssueCommentPage {
  nodes: Array<{ agentSessionId?: string | null }>;
  pageInfo: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
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
 * The Linear SDK types state.type as `string`, but the actual values are always one of:
 * triage, backlog, unstarted, started, completed, canceled.
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
      return "unstarted";
  }
}

/**
 * Maps elicitation signals to Linear's AgentActivitySignal
 *
 * Only auth and select are valid agent-to-human signals per Linear docs.
 */
function mapElicitationSignal(
  signal: ElicitationSignal,
): AgentActivitySignal | undefined {
  switch (signal) {
    case "auth":
      return AgentActivitySignal.Auth;
    case "select":
      return AgentActivitySignal.Select;
    default:
      return undefined;
  }
}

/**
 * Linear SDK implementation of LinearService
 */
export class LinearServiceImpl implements LinearService {
  private readonly client: LinearClient;
  private readonly log: Logger;

  constructor(accessToken: string) {
    this.client = new LinearClient({ accessToken });
    this.log = Log.create({ service: "linear" });
  }

  // ─────────────────────────────────────────────────────────────
  // Agent Activity Methods
  // ─────────────────────────────────────────────────────────────

  async postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral = false,
  ): Promise<Result<void, LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content,
          ephemeral,
        }),
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to send activity", {
        activityType: content.type,
        sessionId,
        ephemeral,
        error: result.error.message,
        errorType: result.error._tag,
      });
      return Result.err(result.error);
    }

    return Result.ok(undefined);
  }

  async postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void, LinearServiceError>> {
    const baseMessage = STAGE_MESSAGES[stage];
    const body = details ? `${baseMessage}\n\n${details}` : baseMessage;

    const result = await Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content: { type: "thought", body },
          ephemeral: true,
        }),
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to send stage activity", {
        processingStage: stage,
        sessionId,
        error: result.error.message,
        errorType: result.error._tag,
      });
      return Result.err(result.error);
    }

    return Result.ok(undefined);
  }

  async postError(
    sessionId: string,
    error: unknown,
  ): Promise<Result<void, LinearServiceError>> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const truncatedStack = errorStack
      ? errorStack.split("\n").slice(0, 20).join("\n")
      : undefined;

    const errorBody = truncatedStack
      ? `**Error:** ${errorMessage}\n\n**Stack trace:**\n\`\`\`\n${truncatedStack}\n\`\`\``
      : `**Error:** ${errorMessage}`;

    const result = await Result.tryPromise({
      try: async () =>
        this.client.createAgentActivity({
          agentSessionId: sessionId,
          content: { type: "error", body: errorBody },
          ephemeral: false,
        }),
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to report error to Linear", {
        sessionId,
        originalError: errorMessage,
        reportError: result.error.message,
        errorType: result.error._tag,
      });
      return Result.err(result.error);
    }

    return Result.ok(undefined);
  }

  async postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, LinearServiceError>> {
    const result = await Result.tryPromise({
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
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to send elicitation", {
        sessionId,
        signal,
        error: result.error.message,
        errorType: result.error._tag,
      });
      return Result.err(result.error);
    }

    return Result.ok(undefined);
  }

  async setExternalLink(
    sessionId: string,
    url: string,
  ): Promise<Result<void, LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () => {
        const agentSession = await this.client.agentSession(sessionId);
        await agentSession.update({ externalLink: url });
      },
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to set external link", {
        sessionId,
        url,
        error: result.error.message,
        errorType: result.error._tag,
      });
      return result;
    }

    return Result.ok(undefined);
  }

  async updatePlan(
    sessionId: string,
    plan: PlanItem[],
  ): Promise<Result<void, LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () => {
        const agentSession = await this.client.agentSession(sessionId);
        await agentSession.update({ plan });
      },
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to update plan", {
        sessionId,
        planItemCount: plan.length,
        error: result.error.message,
        errorType: result.error._tag,
      });
      return result;
    }

    return Result.ok(undefined);
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  async getIssue(
    issueId: string,
  ): Promise<Result<LinearIssue, LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description ?? undefined,
          url: issue.url,
        };
      },
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue", {
        issueId,
        error: result.error.message,
        errorType: result.error._tag,
      });
    }

    return result;
  }

  async getIssueLabels(
    issueId: string,
  ): Promise<Result<LinearLabel[], LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const labels = await issue.labels();
        return labels.nodes.map((label) => ({
          id: label.id,
          name: label.name,
        }));
      },
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue labels", {
        issueId,
        error: result.error.message,
        errorType: result.error._tag,
      });
    }

    return result;
  }

  async getIssueAttachments(
    issueId: string,
  ): Promise<Result<LinearAttachment[], LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(issueId);
        const attachments = await issue.attachments();
        return attachments.nodes.map((attachment) => ({
          id: attachment.id,
          url: attachment.url ?? undefined,
          title: attachment.title,
        }));
      },
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue attachments", {
        issueId,
        error: result.error.message,
        errorType: result.error._tag,
      });
    }

    return result;
  }

  async getIssueAgentSessionIds(
    issueId: string,
  ): Promise<Result<string[], LinearServiceError>> {
    const result = await Result.tryPromise({
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
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue agent sessions", {
        issueId,
        error: result.error.message,
        errorType: result.error._tag,
      });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Update Methods
  // ─────────────────────────────────────────────────────────────

  async moveIssueToInProgress(
    issueId: string,
  ): Promise<Result<void, LinearServiceError>> {
    const result = await Result.tryPromise({
      try: async () => {
        // Get the issue to find its team
        const issue = await this.client.issue(issueId);
        const team = await issue.team;

        if (!team) {
          throw new Error("Issue has no associated team");
        }

        // Query the team's workflow states to find the first "started" status
        // Per Linear docs: filter by type "started" and select lowest position
        const states = await team.states({
          filter: { type: { eq: "started" } },
        });

        if (states.nodes.length === 0) {
          throw new Error("Team has no started workflow states");
        }

        // Sort by position and take the first one (lowest position = first in workflow)
        const sortedStates = states.nodes.toSorted(
          (a, b) => a.position - b.position,
        );
        const inProgressState = sortedStates[0];

        if (!inProgressState) {
          this.log.warn("No In Progress state found", { issueId });
          return;
        }

        this.log.info("Moving issue to In Progress", {
          issueId,
          stateId: inProgressState.id,
          stateName: inProgressState.name,
        });

        // Update the issue's state
        await issue.update({ stateId: inProgressState.id });
      },
      catch: mapLinearError,
    });

    if (Result.isError(result)) {
      this.log.error("Failed to move issue to In Progress", {
        issueId,
        error: result.error.message,
        errorType: result.error._tag,
      });
      return Result.err(result.error);
    }

    return Result.ok(undefined);
  }

  async getIssueState(
    issueId: string,
  ): Promise<Result<IssueState, LinearServiceError>> {
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
      catch: mapLinearError,
    });
  }
}
