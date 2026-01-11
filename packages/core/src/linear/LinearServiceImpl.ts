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
  PlanItem,
  ProcessingStage,
  SignalMetadata,
} from "./types";
import { STAGE_MESSAGES } from "./types";
import { Log, type Logger } from "../logger";

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
 * Ensure error is an Error instance
 */
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
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
  ): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(async () =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content,
        ephemeral,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to send activity", {
        activityType: content.type,
        sessionId,
        ephemeral,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return Result.ok(undefined);
  }

  async postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<Result<void, Error>> {
    const baseMessage = STAGE_MESSAGES[stage];
    const body = details ? `${baseMessage}\n\n${details}` : baseMessage;

    const result = await Result.tryPromise(async () =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: { type: "thought", body },
        ephemeral: true,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to send stage activity", {
        processingStage: stage,
        sessionId,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return Result.ok(undefined);
  }

  async postError(
    sessionId: string,
    error: unknown,
  ): Promise<Result<void, Error>> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const truncatedStack = errorStack
      ? errorStack.split("\n").slice(0, 20).join("\n")
      : undefined;

    const errorBody = truncatedStack
      ? `**Error:** ${errorMessage}\n\n**Stack trace:**\n\`\`\`\n${truncatedStack}\n\`\`\``
      : `**Error:** ${errorMessage}`;

    const result = await Result.tryPromise(async () =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: { type: "error", body: errorBody },
        ephemeral: false,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to report error to Linear", {
        sessionId,
        originalError: errorMessage,
        reportError: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return Result.ok(undefined);
  }

  async postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(async () =>
      this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "elicitation",
          body,
          signalMetadata: metadata,
        },
        signal: mapElicitationSignal(signal),
        ephemeral: false,
      }),
    );

    if (Result.isError(result)) {
      this.log.error("Failed to send elicitation", {
        sessionId,
        signal,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return Result.ok(undefined);
  }

  async setExternalLink(
    sessionId: string,
    url: string,
  ): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(async () => {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ externalLink: url });
    });

    if (Result.isError(result)) {
      this.log.error("Failed to set external link", {
        sessionId,
        url,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return Result.ok(undefined);
  }

  async updatePlan(
    sessionId: string,
    plan: PlanItem[],
  ): Promise<Result<void, Error>> {
    const result = await Result.tryPromise(async () => {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ plan });
    });

    if (Result.isError(result)) {
      this.log.error("Failed to update plan", {
        sessionId,
        planItemCount: plan.length,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return Result.ok(undefined);
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Query Methods
  // ─────────────────────────────────────────────────────────────

  async getIssue(issueId: string): Promise<Result<LinearIssue, Error>> {
    const result = await Result.tryPromise(async () => {
      const issue = await this.client.issue(issueId);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
      };
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue", {
        issueId,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return result;
  }

  async getIssueLabels(issueId: string): Promise<Result<LinearLabel[], Error>> {
    const result = await Result.tryPromise(async () => {
      const issue = await this.client.issue(issueId);
      const labels = await issue.labels();
      return labels.nodes.map((label) => ({
        id: label.id,
        name: label.name,
      }));
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue labels", {
        issueId,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return result;
  }

  async getIssueAttachments(
    issueId: string,
  ): Promise<Result<LinearAttachment[], Error>> {
    const result = await Result.tryPromise(async () => {
      const issue = await this.client.issue(issueId);
      const attachments = await issue.attachments();
      return attachments.nodes.map((attachment) => ({
        id: attachment.id,
        url: attachment.url ?? undefined,
        title: attachment.title,
      }));
    });

    if (Result.isError(result)) {
      this.log.error("Failed to get issue attachments", {
        issueId,
        error: toError(result.error).message,
      });
      return Result.err(toError(result.error));
    }

    return result;
  }
}
