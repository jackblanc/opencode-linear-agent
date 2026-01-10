import type { OpencodeClient, Message, Part } from "@opencode-ai/sdk/v2";
import type { SessionRepository } from "./SessionRepository";
import type { SessionState } from "./SessionState";
import { Log, type Logger } from "../logger";

/**
 * Result of getting or creating a session
 */
export interface SessionResult {
  opcodeSessionId: string;
  existingState: SessionState | null;
  /** True if we had to create a new OpenCode session (old one was lost) */
  isNewSession: boolean;
  /** Previous message history if session was recreated */
  previousContext?: string;
}

/**
 * Format message history into a context string for injection into new sessions
 */
function formatMessageHistory(
  messages: Array<{ info: Message; parts: Array<Part> }>,
): string {
  if (messages.length === 0) {
    return "";
  }

  const formattedMessages: string[] = [];

  for (const message of messages) {
    const role = message.info.role === "user" ? "User" : "Assistant";
    const parts: string[] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text && !part.synthetic && !part.ignored) {
          parts.push(part.text);
        }
      } else if (part.type === "tool") {
        if (part.state.status === "completed") {
          parts.push(`[Used tool: ${part.tool}]`);
        }
      }
    }

    if (parts.length > 0) {
      formattedMessages.push(`**${role}:**\n${parts.join("\n")}`);
    }
  }

  if (formattedMessages.length === 0) {
    return "";
  }

  return `## Previous Session Context

The following is a summary of our previous conversation. Please continue from where we left off.

---

${formattedMessages.join("\n\n---\n\n")}

---

`;
}

/**
 * Manages the lifecycle of OpenCode sessions linked to Linear sessions
 */
export class SessionManager {
  constructor(
    private readonly opcodeClient: OpencodeClient,
    private readonly repository: SessionRepository,
  ) {}

  /**
   * Get or create an OpenCode session for a Linear session
   *
   * @returns Object containing the session ID, existing state, and whether this is a new session
   */
  async getOrCreateSession(
    linearSessionId: string,
    issue: string,
    branchName: string,
    workdir: string,
  ): Promise<SessionResult> {
    const log = Log.create({ service: "session" })
      .tag("issue", issue)
      .tag("sessionId", linearSessionId);

    log.info("Looking up existing session state");

    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.opencodeSessionId) {
      log.tag("opcodeSession", existingState.opencodeSessionId.slice(0, 8));
      log.tag("opcodeSessionId", existingState.opencodeSessionId);
      log.info("Found existing state, attempting to resume");

      try {
        const session = await this.opcodeClient.session.get({
          sessionID: existingState.opencodeSessionId,
          directory: workdir,
        });

        if (session.data) {
          log.info("Successfully resumed session");
          return {
            opcodeSessionId: session.data.id,
            existingState,
            isNewSession: false,
          };
        }

        // Session not found in OpenCode - try to fetch previous messages before creating new
        log.warn("Session not found, fetching previous context");

        const previousContext = await this.fetchPreviousContext(
          existingState.opencodeSessionId,
          workdir,
          log,
        );

        return this.createNewSession(
          linearSessionId,
          issue,
          branchName,
          workdir,
          existingState,
          previousContext,
          log,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log.warn("Failed to resume session, fetching previous context", {
          error: errorMessage,
        });

        // Try to fetch previous context before creating new session
        const previousContext = await this.fetchPreviousContext(
          existingState.opencodeSessionId,
          workdir,
          log,
        );

        return this.createNewSession(
          linearSessionId,
          issue,
          branchName,
          workdir,
          existingState,
          previousContext,
          log,
        );
      }
    }

    // No existing state - create fresh session
    return this.createNewSession(
      linearSessionId,
      issue,
      branchName,
      workdir,
      null,
      undefined,
      log,
    );
  }

  /**
   * Fetch previous message context from an old OpenCode session
   */
  private async fetchPreviousContext(
    opcodeSessionId: string,
    workdir: string,
    log: Logger,
  ): Promise<string | undefined> {
    try {
      const messagesResult = await this.opcodeClient.session.messages({
        sessionID: opcodeSessionId,
        directory: workdir,
      });

      if (messagesResult.data && messagesResult.data.length > 0) {
        log.info("Fetched previous messages for context", {
          messageCount: messagesResult.data.length,
        });
        return formatMessageHistory(messagesResult.data);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.warn("Failed to fetch previous messages", { error: errorMessage });
    }
    return undefined;
  }

  /**
   * Create a new OpenCode session
   */
  private async createNewSession(
    linearSessionId: string,
    issue: string,
    branchName: string,
    workdir: string,
    existingState: SessionState | null,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<SessionResult> {
    log.info("Creating new OpenCode session", {
      hasPreviousContext: !!previousContext,
    });

    const session = await this.opcodeClient.session.create({
      title: `Linear Issue ${issue}`,
      directory: workdir,
    });

    if (!session.data) {
      log.error("OpenCode API returned no data when creating session");
      throw new Error("Failed to create OpenCode session");
    }

    log.tag("opcodeSession", session.data.id.slice(0, 8));
    log.tag("opcodeSessionId", session.data.id);
    log.info("Created OpenCode session");

    const newState: SessionState = {
      opencodeSessionId: session.data.id,
      linearSessionId,
      issueId: issue,
      branchName,
      workdir,
      lastActivityTime: Date.now(),
    };

    await this.repository.save(newState);

    log.info("Saved session state to repository", { branchName, workdir });

    return {
      opcodeSessionId: session.data.id,
      existingState,
      isNewSession: true,
      previousContext,
    };
  }

  /**
   * Update last activity time for a session
   */
  async touch(linearSessionId: string): Promise<void> {
    const state = await this.repository.get(linearSessionId);
    if (state) {
      state.lastActivityTime = Date.now();
      await this.repository.save(state);
    }
  }

  /**
   * Clean up session state
   */
  async cleanup(linearSessionId: string): Promise<void> {
    await this.repository.delete(linearSessionId);
  }
}
