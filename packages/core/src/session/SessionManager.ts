import type { OpencodeClient, Message, Part } from "@opencode-ai/sdk/v2";
import type { SessionRepository } from "./SessionRepository";
import type { SessionState } from "./SessionState";

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
    issueId: string,
    branchName: string,
    workdir: string,
  ): Promise<SessionResult> {
    console.info({
      message: "Looking up existing session state",
      stage: "session",
      linearSessionId,
      issueId,
    });

    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.opencodeSessionId) {
      console.info({
        message: "Found existing state, attempting to resume",
        stage: "session",
        linearSessionId,
        opcodeSessionId: existingState.opencodeSessionId,
      });

      try {
        const session = await this.opcodeClient.session.get({
          sessionID: existingState.opencodeSessionId,
          directory: workdir,
        });

        if (session.data) {
          console.info({
            message: "Successfully resumed session",
            stage: "session",
            linearSessionId,
            opcodeSessionId: session.data.id,
          });
          return {
            opcodeSessionId: session.data.id,
            existingState,
            isNewSession: false,
          };
        }

        // Session not found in OpenCode - try to fetch previous messages before creating new
        console.warn({
          message: "Session not found, fetching previous context",
          stage: "session",
          linearSessionId,
          opcodeSessionId: existingState.opencodeSessionId,
        });

        const previousContext = await this.fetchPreviousContext(
          existingState.opencodeSessionId,
          workdir,
        );

        return this.createNewSession(
          linearSessionId,
          issueId,
          branchName,
          workdir,
          existingState,
          previousContext,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn({
          message: "Failed to resume session, fetching previous context",
          stage: "session",
          error: errorMessage,
          linearSessionId,
          opcodeSessionId: existingState.opencodeSessionId,
        });

        // Try to fetch previous context before creating new session
        const previousContext = await this.fetchPreviousContext(
          existingState.opencodeSessionId,
          workdir,
        );

        return this.createNewSession(
          linearSessionId,
          issueId,
          branchName,
          workdir,
          existingState,
          previousContext,
        );
      }
    }

    // No existing state - create fresh session
    return this.createNewSession(
      linearSessionId,
      issueId,
      branchName,
      workdir,
      null,
      undefined,
    );
  }

  /**
   * Fetch previous message context from an old OpenCode session
   */
  private async fetchPreviousContext(
    opcodeSessionId: string,
    workdir: string,
  ): Promise<string | undefined> {
    try {
      const messagesResult = await this.opcodeClient.session.messages({
        sessionID: opcodeSessionId,
        directory: workdir,
      });

      if (messagesResult.data && messagesResult.data.length > 0) {
        console.info({
          message: "Fetched previous messages for context",
          stage: "session",
          opcodeSessionId,
          messageCount: messagesResult.data.length,
        });
        return formatMessageHistory(messagesResult.data);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn({
        message: "Failed to fetch previous messages",
        stage: "session",
        error: errorMessage,
        opcodeSessionId,
      });
    }
    return undefined;
  }

  /**
   * Create a new OpenCode session
   */
  private async createNewSession(
    linearSessionId: string,
    issueId: string,
    branchName: string,
    workdir: string,
    existingState: SessionState | null,
    previousContext: string | undefined,
  ): Promise<SessionResult> {
    console.info({
      message: "Creating new OpenCode session",
      stage: "session",
      linearSessionId,
      issueId,
      hasPreviousContext: !!previousContext,
    });

    const session = await this.opcodeClient.session.create({
      title: `Linear Issue ${issueId}`,
      directory: workdir,
    });

    if (!session.data) {
      console.error({
        message: "OpenCode API returned no data when creating session",
        stage: "session",
        linearSessionId,
      });
      throw new Error("Failed to create OpenCode session");
    }

    console.info({
      message: "Created OpenCode session",
      stage: "session",
      linearSessionId,
      opcodeSessionId: session.data.id,
    });

    const newState: SessionState = {
      opencodeSessionId: session.data.id,
      linearSessionId,
      issueId,
      branchName,
      workdir,
      lastActivityTime: Date.now(),
    };

    await this.repository.save(newState);

    console.info({
      message: "Saved session state to repository",
      stage: "session",
      linearSessionId,
      opcodeSessionId: session.data.id,
      branchName,
      workdir,
    });

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
