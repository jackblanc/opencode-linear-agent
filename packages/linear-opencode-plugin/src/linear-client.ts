import { LinearClient } from "@linear/sdk";
import type { LinearActivityContent, LinearPlanStep } from "./types";

/**
 * Wrapper around Linear SDK for agent operations.
 * Uses the official SDK instead of raw GraphQL mutations.
 */
export class LinearAgentClient {
  private client: LinearClient;
  private debug: boolean;

  constructor(accessToken: string, debug = false) {
    this.client = new LinearClient({ accessToken });
    this.debug = debug;
  }

  /**
   * Create an activity in a Linear agent session.
   */
  async createActivity(
    sessionId: string,
    content: LinearActivityContent,
    ephemeral = false
  ): Promise<void> {
    if (this.debug) {
      console.log("[linear-client] createActivity", {
        sessionId,
        content,
        ephemeral,
      });
    }

    try {
      const result = await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content,
        ephemeral,
      });

      if (this.debug) {
        console.log("[linear-client] createActivity result:", result);
      }
    } catch (error) {
      console.error("[linear-client] Failed to create activity:", error);
      throw error;
    }
  }

  /**
   * Update the plan for a Linear agent session.
   */
  async updatePlan(sessionId: string, plan: LinearPlanStep[]): Promise<void> {
    if (this.debug) {
      console.log("[linear-client] updatePlan", { sessionId, plan });
    }

    try {
      const result = await this.client.agentSessionUpdate(sessionId, { plan });

      if (this.debug) {
        console.log("[linear-client] updatePlan result:", result);
      }
    } catch (error) {
      console.error("[linear-client] Failed to update plan:", error);
      throw error;
    }
  }

  /**
   * Send a thought activity (ephemeral by default).
   */
  async sendThought(
    sessionId: string,
    body: string,
    ephemeral = true
  ): Promise<void> {
    await this.createActivity(sessionId, { type: "thought", body }, ephemeral);
  }

  /**
   * Send a response activity (persistent).
   */
  async sendResponse(sessionId: string, body: string): Promise<void> {
    await this.createActivity(
      sessionId,
      { type: "response", body },
      false
    );
  }

  /**
   * Send an action activity.
   */
  async sendAction(
    sessionId: string,
    action: string,
    parameter: string,
    result?: string,
    ephemeral = false
  ): Promise<void> {
    await this.createActivity(
      sessionId,
      { type: "action", action, parameter, result },
      ephemeral
    );
  }

  /**
   * Send an error activity (persistent).
   */
  async sendError(sessionId: string, body: string): Promise<void> {
    await this.createActivity(sessionId, { type: "error", body }, false);
  }
}
