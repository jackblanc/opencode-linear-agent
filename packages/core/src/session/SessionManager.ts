import { Result } from "better-result";
import type { SessionRepository } from "./SessionRepository";
import type { SessionState } from "./SessionState";
import type {
  OpencodeService,
  MessageWithParts,
} from "../opencode-service/OpencodeService";
import type { OpencodeServiceError } from "../opencode-service/errors";
import { Log, type Logger } from "../utils/logger";

/**
 * Result of getting or creating a session
 */
interface SessionResult {
  opencodeSessionId: string;
  existingState: SessionState | null;
  /** True if we had to create a new OpenCode session (old one was lost) */
  isNewSession: boolean;
  /** Previous message history if session was recreated */
  previousContext?: string;
}

/**
 * Format message history into a context string for injection into new sessions
 */
function formatMessageHistory(messages: MessageWithParts[]): string {
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
    private readonly opencode: OpencodeService,
    private readonly repository: SessionRepository,
  ) {}

  /**
   * Get or create an OpenCode session for a Linear session
   *
   * @returns Result containing the session ID, existing state, and whether this is a new session
   */
  async getOrCreateSession(
    linearSessionId: string,
    organizationId: string,
    issueId: string,
    repoDirectory: string,
    branchName: string,
    workdir: string,
  ): Promise<Result<SessionResult, OpencodeServiceError>> {
    const log = Log.create({ service: "session" })
      .tag("issue", issueId)
      .tag("sessionId", linearSessionId);

    log.info("Looking up existing session state");

    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.opencodeSessionId) {
      const sessionLog = log
        .tag("opencodeSession", existingState.opencodeSessionId.slice(0, 8))
        .tag("opencodeSessionId", existingState.opencodeSessionId);
      sessionLog.info("Found existing state, attempting to resume");

      const sessionResult = await this.opencode.getSession(
        existingState.opencodeSessionId,
        workdir,
      );

      if (Result.isOk(sessionResult)) {
        sessionLog.info("Successfully resumed session");
        return Result.ok({
          opencodeSessionId: sessionResult.value.id,
          existingState,
          isNewSession: false,
        });
      }

      // Session not found or error - log and try to fetch previous context
      sessionLog.warn("Failed to resume session, fetching previous context", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });

      const previousContext = await this.fetchPreviousContext(
        existingState.opencodeSessionId,
        workdir,
        sessionLog,
      );

      const sessionRepoDirectory = existingState.repoDirectory ?? repoDirectory;
      if (!existingState.repoDirectory) {
        log.warn("Existing session state missing repo directory", {
          fallbackRepoDirectory: repoDirectory,
          workdir,
          branchName,
        });
      }

      return this.createNewSession(
        linearSessionId,
        organizationId,
        issueId,
        sessionRepoDirectory,
        branchName,
        workdir,
        existingState,
        previousContext,
        sessionLog,
      );
    }

    // No existing state - create fresh session
    return this.createNewSession(
      linearSessionId,
      organizationId,
      issueId,
      repoDirectory,
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
    opencodeSessionId: string,
    workdir: string,
    log: Logger,
  ): Promise<string | undefined> {
    const messagesResult = await this.opencode.getMessages(
      opencodeSessionId,
      workdir,
    );

    if (Result.isError(messagesResult)) {
      log.warn("Failed to fetch previous messages", {
        error: messagesResult.error.message,
        errorType: messagesResult.error._tag,
      });
      return undefined;
    }

    if (messagesResult.value.length > 0) {
      log.info("Fetched previous messages for context", {
        messageCount: messagesResult.value.length,
      });
      return formatMessageHistory(messagesResult.value);
    }

    return undefined;
  }

  /**
   * Create a new OpenCode session
   */
  private async createNewSession(
    linearSessionId: string,
    organizationId: string,
    issueId: string,
    repoDirectory: string,
    branchName: string,
    workdir: string,
    existingState: SessionState | null,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<Result<SessionResult, OpencodeServiceError>> {
    log.info("Creating new OpenCode session", {
      hasPreviousContext: !!previousContext,
    });

    // Don't pass a title - OpenCode auto-generates titles based on the first prompt
    const sessionResult = await this.opencode.createSession(workdir);

    if (Result.isError(sessionResult)) {
      log.error("Failed to create OpenCode session", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });
      return Result.err(sessionResult.error);
    }

    const sessionId = sessionResult.value.id;

    const sessionLog = log
      .tag("opencodeSession", sessionId.slice(0, 8))
      .tag("opencodeSessionId", sessionId);
    sessionLog.info("Created OpenCode session");

    const newState: SessionState = {
      opencodeSessionId: sessionId,
      linearSessionId,
      organizationId,
      issueId,
      repoDirectory,
      branchName,
      workdir,
      lastActivityTime: Date.now(),
    };

    await this.repository.save(newState);

    sessionLog.info("Saved session state to repository", {
      branchName,
      workdir,
    });

    return Result.ok({
      opencodeSessionId: sessionId,
      existingState,
      isNewSession: true,
      previousContext,
    });
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
