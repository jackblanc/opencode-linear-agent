import type { ActivityContent, PlanItem } from "./types";

/**
 * Signal to send with an activity
 */
export type ActivitySignal = "stop";

/**
 * Adapter interface for Linear API operations
 */
export interface LinearAdapter {
  /**
   * Post an activity to a Linear session
   */
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
    signal?: ActivitySignal,
  ): Promise<void>;

  /**
   * Post an error activity to a Linear session
   */
  postError(sessionId: string, error: unknown): Promise<void>;

  /**
   * Set the external link for a Linear session
   */
  setExternalLink(sessionId: string, url: string): Promise<void>;

  /**
   * Update the plan for a Linear session
   */
  updatePlan(sessionId: string, plan: PlanItem[]): Promise<void>;
}
