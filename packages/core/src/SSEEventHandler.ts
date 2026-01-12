import type { Event as OpencodeEvent, Part } from "@opencode-ai/sdk/v2";
import type { LinearService } from "./linear/LinearService";
import type { PendingQuestion } from "./session/SessionRepository";
import type { OpencodeService } from "./opencode/OpencodeService";
import type { Logger } from "./logger";
import { ToolHandler } from "./handlers/ToolHandler";
import { TextHandler } from "./handlers/TextHandler";
import { TodoHandler } from "./handlers/TodoHandler";
import { PermissionHandler } from "./handlers/PermissionHandler";
import { QuestionHandler } from "./handlers/QuestionHandler";

/**
 * Result from handling an SSE event
 */
export type SSEEventResult =
  | { action: "continue" }
  | { action: "break" }
  | { action: "question_asked"; pendingQuestion: PendingQuestion };

/**
 * Handles SSE events from OpenCode and posts activities to Linear.
 *
 * This replaces the plugin-based approach with a pure SDK/SSE approach,
 * keeping all Linear communication in the worker instead of the container.
 *
 * Delegates to specialized handlers for each event type:
 * - ToolHandler: Tool part processing, action name mapping
 * - TextHandler: Text part processing, response posting
 * - TodoHandler: Todo sync to Linear plan
 * - PermissionHandler: Auto-approval logic
 * - QuestionHandler: Elicitation posting
 */
export class SSEEventHandler {
  private readonly toolHandler: ToolHandler;
  private readonly textHandler: TextHandler;
  private readonly todoHandler: TodoHandler;
  private readonly permissionHandler: PermissionHandler;
  private readonly questionHandler: QuestionHandler;

  constructor(
    private readonly linear: LinearService,
    private readonly linearSessionId: string,
    private readonly opencodeSessionId: string,
    opencode: OpencodeService,
    private readonly log: Logger,
    private readonly workdir: string | null = null,
  ) {
    this.toolHandler = new ToolHandler(linear, linearSessionId, log, workdir);
    this.textHandler = new TextHandler(linear, linearSessionId, log);
    this.todoHandler = new TodoHandler(
      linear,
      linearSessionId,
      opencodeSessionId,
      log,
    );
    this.permissionHandler = new PermissionHandler(
      opencode,
      opencodeSessionId,
      log,
      workdir,
    );
    this.questionHandler = new QuestionHandler(
      linear,
      linearSessionId,
      opencodeSessionId,
      log,
      workdir,
    );
  }

  /**
   * Handle an SSE event from OpenCode
   *
   * @returns SSEEventResult indicating whether to continue, break, or retry
   */
  async handleEvent(event: OpencodeEvent): Promise<SSEEventResult> {
    // Handle specific event types we care about
    // Other event types (message.updated, session.created, etc.) are logged but not acted upon
    if (event.type === "message.part.updated") {
      await this.handlePartUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "todo.updated") {
      await this.todoHandler.handleTodoUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "permission.asked") {
      await this.permissionHandler.handlePermissionAsked(event.properties);
      return { action: "continue" };
    }

    // Handle question.asked events - post elicitations to Linear and return pending question data
    if (event.type === "question.asked") {
      const pending = await this.questionHandler.handleQuestionAsked(
        event.properties,
      );
      if (pending) {
        return { action: "question_asked", pendingQuestion: pending };
      }
      return { action: "continue" };
    }

    if (event.type === "session.idle") {
      if (event.properties.sessionID === this.opencodeSessionId) {
        await this.handleSessionIdle();
        return { action: "break" };
      }
      return { action: "continue" };
    }

    if (event.type === "session.error") {
      if (event.properties.sessionID === this.opencodeSessionId) {
        return await this.handleSessionError(event.properties);
      }
      return { action: "continue" };
    }

    // All other event types - continue without action
    return { action: "continue" };
  }

  /**
   * Handle message.part.updated events
   */
  private async handlePartUpdated(properties: {
    part: Part;
    delta?: string;
  }): Promise<void> {
    const { part } = properties;

    // Only process parts for our session
    if (part.sessionID !== this.opencodeSessionId) {
      return;
    }

    // Handle tool and text parts - other part types are ignored
    if (part.type === "tool") {
      await this.toolHandler.handleToolPart(part);
    } else if (part.type === "text") {
      await this.textHandler.handleTextPart(part);
    }
  }

  /**
   * Handle session.idle - send completion response to Linear if needed
   *
   * If we already posted the agent's final text as a response, skip posting again.
   * Otherwise, post a default completion message.
   */
  private async handleSessionIdle(): Promise<void> {
    const postedFinalResponse = this.textHandler.hasPostedFinalResponse();

    this.log.info("Session idle", { postedFinalResponse });

    // Skip if we already posted the agent's final response via handleTextPart
    if (postedFinalResponse) {
      this.log.info(
        "Skipping duplicate response - already posted via text part",
      );
      return;
    }

    // Post a default completion message if agent didn't produce text output
    await this.linear.postActivity(
      this.linearSessionId,
      { type: "response", body: "Work completed." },
      false, // persistent
    );
  }

  /**
   * Handle session.error - report error to Linear
   */
  private async handleSessionError(properties: {
    sessionID?: string;
    error?: {
      name?: string;
      data?: { message?: string };
    };
  }): Promise<SSEEventResult> {
    const { error } = properties;

    let errorMessage = "Unknown error";
    if (error?.data?.message) {
      errorMessage = error.data.message;
    } else if (error?.name) {
      errorMessage = error.name;
    }

    this.log.error("Session error", { error: errorMessage });

    await this.linear.postError(this.linearSessionId, new Error(errorMessage));
    return { action: "break" };
  }
}
