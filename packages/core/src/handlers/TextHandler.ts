import type { TextPart } from "@opencode-ai/sdk/v2";
import type { LinearService } from "../linear/LinearService";
import type { Logger } from "../logger";

/**
 * Handles text part events from OpenCode and posts activities to Linear.
 *
 * Text parts are posted as response activities when complete.
 * We detect completion by checking if time.end is set.
 */
export class TextHandler {
  /** Track sent text part IDs to avoid duplicates */
  private sentTextParts = new Set<string>();

  /** Track agent's last text response for session completion */
  private agentFinalMessage: string | null = null;

  /** Track if we've already posted a final response to avoid duplicates */
  private postedFinalResponse = false;

  constructor(
    private readonly linear: LinearService,
    private readonly linearSessionId: string,
    private readonly log: Logger,
  ) {}

  /**
   * Check if a final response has been posted
   */
  hasPostedFinalResponse(): boolean {
    return this.postedFinalResponse;
  }

  /**
   * Get the agent's final message
   */
  getAgentFinalMessage(): string | null {
    return this.agentFinalMessage;
  }

  /**
   * Handle a text part update
   */
  async handleTextPart(part: TextPart): Promise<void> {
    const { id, text, time } = part;

    // Skip empty text
    if (!text.trim()) {
      return;
    }

    // Only process complete text parts (has end time)
    // Streaming parts arrive without time.end, we wait for the final update
    if (!time?.end) {
      return;
    }

    // Skip if already sent (check AFTER confirming it's complete)
    // This prevents posting the same completed text twice
    if (this.sentTextParts.has(id)) {
      return;
    }

    // Track the agent's final message
    this.agentFinalMessage = text;

    this.log.info("Text complete", { textLength: text.length });

    await this.linear.postActivity(
      this.linearSessionId,
      { type: "response", body: text },
      false, // persistent
    );

    // Mark as sent AFTER successful post
    this.sentTextParts.add(id);

    // Mark that we've posted a final response (for handleSessionIdle)
    this.postedFinalResponse = true;
  }
}
