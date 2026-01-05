import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import type {
  LinearAdapter,
  ActivitySignal,
  ActivityContent,
  PlanItem,
} from "@linear-opencode-agent/core";

/**
 * Maps our ActivitySignal type to Linear's AgentActivitySignal
 */
function mapSignal(signal?: ActivitySignal): AgentActivitySignal | undefined {
  if (signal === "stop") {
    return AgentActivitySignal.Stop;
  }
  return undefined;
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
      console.error(
        `[linear] Failed to send ${content.type} activity to session ${sessionId}: ${errorMessage}`,
      );
    }
  }

  async postError(sessionId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    try {
      await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content: {
          type: "error",
          body: `Processing failed: ${errorMessage}`,
        },
        ephemeral: false,
      });
    } catch (reportError) {
      const reportErrorMessage =
        reportError instanceof Error
          ? reportError.message
          : String(reportError);
      console.error(
        `[linear] Failed to report error to session ${sessionId}: ${reportErrorMessage}`,
      );
    }
  }

  async setExternalLink(sessionId: string, url: string): Promise<void> {
    try {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ externalLink: url });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[linear] Failed to set external link for session ${sessionId}: ${errorMessage}`,
      );
    }
  }

  async updatePlan(sessionId: string, plan: PlanItem[]): Promise<void> {
    try {
      const agentSession = await this.client.agentSession(sessionId);
      await agentSession.update({ plan });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[linear] Failed to update plan for session ${sessionId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Get the underlying Linear client for advanced operations
   */
  getClient(): LinearClient {
    return this.client;
  }
}
