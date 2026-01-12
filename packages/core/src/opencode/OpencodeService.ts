import type {
  OpencodeClient,
  Message,
  Part,
  Session,
  Event as OpencodeEvent,
} from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import type { OpencodeServiceError } from "../errors";
import {
  mapOpencodeError,
  getOpencodeErrorMessage,
  OpencodeUnknownError,
} from "../errors";

/**
 * Worktree creation result
 */
export interface WorktreeResult {
  directory: string;
  branch: string;
}

/**
 * Session creation/retrieval result
 */
export interface OpencodeSessionResult {
  id: string;
}

/**
 * Message with parts for context retrieval
 */
export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

/**
 * Wrapper around OpenCode SDK that returns Result types with tagged errors
 *
 * This provides type-safe error handling and eliminates the need for manual
 * error message extraction patterns throughout the codebase.
 */
export class OpencodeService {
  constructor(private readonly client: OpencodeClient) {}

  /**
   * Get the underlying client for operations that need direct access
   * (e.g., event subscriptions which return streams)
   */
  get rawClient(): OpencodeClient {
    return this.client;
  }

  /**
   * Create a worktree
   */
  async createWorktree(
    directory: string,
    name: string,
    startCommand?: string,
  ): Promise<Result<WorktreeResult, OpencodeServiceError>> {
    const result = await this.client.worktree.create({
      directory,
      worktreeCreateInput: { name, startCommand },
    });

    if (!result.data) {
      const errorDetails = this.extractErrorDetails(result.error);
      return Result.err(new OpencodeUnknownError(errorDetails));
    }

    return Result.ok({
      directory: result.data.directory,
      branch: result.data.branch,
    });
  }

  /**
   * Get a session by ID
   */
  async getSession(
    sessionID: string,
    directory: string,
  ): Promise<Result<Session, OpencodeServiceError>> {
    const result = await this.client.session.get({
      sessionID,
      directory,
    });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(result.data);
  }

  /**
   * Create a new session
   *
   * Title is not passed - OpenCode auto-generates titles based on the first prompt
   */
  async createSession(
    directory: string,
  ): Promise<Result<OpencodeSessionResult, OpencodeServiceError>> {
    const result = await this.client.session.create({
      directory,
    });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok({ id: result.data.id });
  }

  /**
   * Abort a session
   */
  async abortSession(
    sessionID: string,
    directory: string,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.session.abort({
      sessionID,
      directory,
    });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Get session messages
   */
  async getMessages(
    sessionID: string,
    directory: string,
  ): Promise<Result<MessageWithParts[], OpencodeServiceError>> {
    const result = await this.client.session.messages({
      sessionID,
      directory,
    });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(result.data);
  }

  /**
   * Reply to a permission request
   */
  async replyPermission(
    requestID: string,
    reply: "always" | "once" | "reject",
    directory?: string,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.permission.reply({
      requestID,
      reply,
      directory,
    });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Send a prompt to a session
   * Uses the model configured in the OpenCode server
   */
  async prompt(
    sessionID: string,
    directory: string,
    parts: Array<{ type: "text"; text: string }>,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.session.prompt({
      sessionID,
      directory,
      parts,
    });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Subscribe to events (returns raw stream - no Result wrapper needed)
   *
   * This returns the raw SSE stream since Result wrapping doesn't make sense
   * for streaming operations. Errors are handled via the stream itself.
   */
  async subscribe(
    directory: string,
  ): Promise<{ stream: AsyncIterable<OpencodeEvent> }> {
    const result = await this.client.event.subscribe({ directory });
    return { stream: result.stream };
  }

  /**
   * Reply to a question request from the AI assistant
   *
   * @param requestId - The question request ID from question.asked event
   * @param answers - Array of answers, one per question. Each answer is an array of selected option labels.
   * @param directory - Working directory for the session
   */
  async replyQuestion(
    requestId: string,
    answers: Array<Array<string>>,
    directory?: string,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.question.reply({
      requestID: requestId,
      directory,
      answers,
    });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  /**
   * Extract error details from SDK response
   */
  private extractErrorDetails(error: unknown): string {
    // Handle structured error responses from OpenCode SDK
    if (typeof error === "object" && error !== null) {
      // Check for errors array (common in SDK responses)
      if (
        "errors" in error &&
        Array.isArray(error.errors) &&
        error.errors.length > 0
      ) {
        return error.errors
          .map((e) => (typeof e === "object" ? JSON.stringify(e) : String(e)))
          .join("; ");
      }

      // Check for message field
      if ("message" in error && typeof error.message === "string") {
        return error.message;
      }
    }

    return getOpencodeErrorMessage(error);
  }
}
