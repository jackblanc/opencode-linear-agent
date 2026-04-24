import type {
  OpencodeClient,
  Message,
  Part,
  QuestionRequest,
  Session,
  Event as OpencodeEvent,
  Project,
} from "@opencode-ai/sdk/v2";

import { Result } from "better-result";

import type { OpencodeServiceError } from "./errors";

import { mapOpencodeError, getOpencodeErrorMessage, OpencodeUnknownError } from "./errors";

interface OpencodeWorktreeResult {
  directory: string;
  branch: string | null;
}

interface OpencodeSessionResult {
  id: string;
}

/**
 * Message with parts for context retrieval
 */
interface MessageWithParts {
  info: Message;
  parts: Part[];
}

interface ProjectListResult {
  projects: Project[];
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

  async createWorktree(
    directory: string,
    branchName: string | null,
    issueId?: string,
  ): Promise<Result<OpencodeWorktreeResult, OpencodeServiceError>> {
    const result = await this.client.worktree.create({
      directory,
      worktreeCreateInput: {
        name: branchName ?? issueId,
      },
    });

    if (!result.data) {
      const errorDetails = this.extractErrorDetails(result.error);
      return Result.err(new OpencodeUnknownError({ reason: errorDetails }));
    }

    if (!result.data.directory) {
      return Result.err(new OpencodeUnknownError({ reason: "Worktree missing directory" }));
    }

    return Result.ok({
      directory: result.data.directory,
      branch: result.data.branch,
    });
  }

  async removeWorktree(
    projectDirectory: string,
    worktreeDirectory: string,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.worktree.remove({
      directory: projectDirectory,
      worktreeRemoveInput: {
        directory: worktreeDirectory,
      },
    });

    if (result.error) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(undefined);
  }

  async listProjects(): Promise<Result<ProjectListResult, OpencodeServiceError>> {
    const result = await this.client.project.list();

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok({ projects: result.data });
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
   * Send a prompt to a session and returns immediately
   *
   * @param sessionID - The session to prompt
   * @param directory - Working directory for the session
   * @param parts - Message parts to send
   * @param agent - Optional agent mode ("build" or "plan"). Defaults to "build" if not specified.
   */
  async prompt(
    sessionID: string,
    directory: string,
    parts: Array<{ type: "text"; text: string }>,
    agent?: string,
  ): Promise<Result<void, OpencodeServiceError>> {
    const result = await this.client.session.promptAsync({
      sessionID,
      directory,
      parts,
      agent,
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
  async subscribe(directory: string): Promise<{ stream: AsyncIterable<OpencodeEvent> }> {
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

  async listPendingQuestions(
    directory?: string,
  ): Promise<Result<QuestionRequest[], OpencodeServiceError>> {
    const result = await this.client.question.list({ directory });

    if (!result.data) {
      return Result.err(mapOpencodeError(result.error));
    }

    return Result.ok(result.data);
  }

  /**
   * Extract error details from SDK response
   */
  private extractErrorDetails(error: unknown): string {
    // Handle structured error responses from OpenCode SDK
    if (typeof error === "object" && error !== null) {
      // Check for errors array (common in SDK responses)
      if ("errors" in error && Array.isArray(error.errors) && error.errors.length > 0) {
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
