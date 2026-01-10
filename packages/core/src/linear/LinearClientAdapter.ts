import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import type { LinearAdapter, ActivitySignal } from "./LinearAdapter";
import type {
  ActivityContent,
  PlanItem,
  ProcessingStage,
  SignalMetadata,
} from "./types";
import { STAGE_MESSAGES } from "./types";

/**
 * Maps our ActivitySignal type to Linear's AgentActivitySignal
 */
function mapSignal(signal?: ActivitySignal): AgentActivitySignal | undefined {
  if (!signal) {
    return undefined;
  }

  switch (signal) {
    case "stop":
      return AgentActivitySignal.Stop;
    case "continue":
      return AgentActivitySignal.Continue;
    case "auth":
      return AgentActivitySignal.Auth;
    case "select":
      return AgentActivitySignal.Select;
    default:
      return undefined;
  }
}

/**
 * Linear SDK implementation of LinearAdapter
 */
export class LinearClientAdapter implements LinearAdapter {
  private readonly client: LinearClient;

  constructor(accessToken: string) {
    this.client = new LinearClient({ accessToken });
  }

  async postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral = false,
    signal?: ActivitySignal,
  ): Promise<void> {
    try {
      await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content,
        ephemeral,
        signal: mapSignal(signal),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Failed to send activity",
        stage: "linear",
        activityType: content.type,
        linearSessionId: sessionId,
        ephemeral,
        error: errorMessage,
      });
    }
  }

  async postStageActivity(
    sessionId: string,
    stage: ProcessingStage,
    details?: string,
  ): Promise<void> {
    const baseMessage = STAGE_MESSAGES[stage];
    const body = details ? `${baseMessage}\n\n${details}` : baseMessage;

    try {
      await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "thought",
          body,
        },
        ephemeral: true,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Failed to send stage activity",
        stage: "linear",
        processingStage: stage,
        linearSessionId: sessionId,
        error: errorMessage,
      });
    }
  }

  async postError(sessionId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Truncate stack traces to first 20 lines to avoid excessive payload size
    const truncatedStack = errorStack
      ? errorStack.split("\n").slice(0, 20).join("\n")
      : undefined;

    // Build the error body with truncated details
    const errorBody = truncatedStack
      ? `**Error:** ${errorMessage}\n\n**Stack trace:**\n\`\`\`\n${truncatedStack}\n\`\`\``
      : `**Error:** ${errorMessage}`;

    try {
      await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "error",
          body: errorBody,
        },
        ephemeral: false,
      });
    } catch (reportError) {
      const reportErrorMessage =
        reportError instanceof Error
          ? reportError.message
          : String(reportError);
      console.error({
        message: "Failed to report error to Linear",
        stage: "linear",
        linearSessionId: sessionId,
        originalError: errorMessage,
        reportError: reportErrorMessage,
      });
    }
  }

  async postElicitation(
    sessionId: string,
    body: string,
    signal: "auth" | "select",
    metadata?: SignalMetadata,
  ): Promise<void> {
    try {
      await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "elicitation",
          body,
          signalMetadata: metadata,
        },
        signal: mapSignal(signal),
        ephemeral: false,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Failed to send elicitation",
        stage: "linear",
        linearSessionId: sessionId,
        signal,
        error: errorMessage,
      });
    }
  }

  async setExternalLink(sessionId: string, url: string): Promise<void> {
    try {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ externalLink: url });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Failed to set external link",
        stage: "linear",
        linearSessionId: sessionId,
        url,
        error: errorMessage,
      });
    }
  }

  async updatePlan(sessionId: string, plan: PlanItem[]): Promise<void> {
    try {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ plan });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Failed to update plan",
        stage: "linear",
        linearSessionId: sessionId,
        planItemCount: plan.length,
        error: errorMessage,
      });
    }
  }

  /**
   * Get the underlying Linear client for advanced operations
   */
  getClient(): LinearClient {
    return this.client;
  }
}
