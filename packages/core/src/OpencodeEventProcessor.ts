import type { Event as OpencodeEvent, Part, Todo } from "@opencode-ai/sdk/v2";
import type { LinearService } from "./linear/LinearService";
import type { PendingQuestion } from "./session/SessionRepository";
import type { OpencodeService } from "./opencode/OpencodeService";
import type { Logger } from "./logger";
import type { HandlerState } from "./session/SessionState";
import { createInitialHandlerState } from "./session/SessionState";
import { ActionExecutor } from "./actions";
import {
  processToolPart,
  processTextPart,
  processTodoUpdated,
  processPermissionAsked,
  processQuestionAsked,
} from "./handlers";

/**
 * Result from processing an OpenCode event
 */
export type OpencodeEventResult =
  | { action: "continue" }
  | { action: "break" }
  | { action: "question_asked"; pendingQuestion: PendingQuestion };

/**
 * Processes events from OpenCode and posts activities to Linear.
 *
 * This replaces the plugin-based approach with a pure SDK/SSE approach,
 * keeping all Linear communication in the worker instead of the container.
 *
 * Uses pure handler functions that take state as input and return
 * new state + actions. The ActionExecutor routes actions to services.
 */
export class OpencodeEventProcessor {
  private readonly actionExecutor: ActionExecutor;
  private handlerState: HandlerState;

  constructor(
    private readonly linear: LinearService,
    private readonly linearSessionId: string,
    private readonly opencodeSessionId: string,
    opencode: OpencodeService,
    private readonly log: Logger,
    private readonly workdir: string | null = null,
  ) {
    this.actionExecutor = new ActionExecutor(linear, opencode);
    this.handlerState = createInitialHandlerState();
  }

  /**
   * Handle an SSE event from OpenCode
   *
   * @returns SSEEventResult indicating whether to continue, break, or retry
   */
  async handleEvent(event: OpencodeEvent): Promise<OpencodeEventResult> {
    // Handle specific event types we care about
    // Other event types (message.updated, session.created, etc.) are logged but not acted upon
    if (event.type === "message.part.updated") {
      await this.handlePartUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "todo.updated") {
      await this.handleTodoUpdated(event.properties);
      return { action: "continue" };
    }

    if (event.type === "permission.asked") {
      await this.handlePermissionAsked(event.properties);
      return { action: "continue" };
    }

    // Handle question.asked events - post elicitations to Linear and return pending question data
    if (event.type === "question.asked") {
      const pending = await this.handleQuestionAsked(event.properties);
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
      const result = processToolPart(part, this.handlerState, {
        linearSessionId: this.linearSessionId,
        workdir: this.workdir,
      });

      this.handlerState = result.state;
      await this.actionExecutor.executeAll(result.actions);
    } else if (part.type === "text") {
      const result = processTextPart(part, this.handlerState, {
        linearSessionId: this.linearSessionId,
      });

      this.handlerState = result.state;
      await this.actionExecutor.executeAll(result.actions);
    }
  }

  /**
   * Handle todo.updated events
   */
  private async handleTodoUpdated(properties: {
    sessionID: string;
    todos: Todo[];
  }): Promise<void> {
    this.log.info("Received todo.updated event", {
      eventSessionID: properties.sessionID,
      ourSessionID: this.opencodeSessionId,
      todoCount: properties.todos.length,
    });

    const actions = processTodoUpdated(properties, {
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
    });

    if (actions.length > 0) {
      this.log.info("Syncing todos to Linear plan", {
        todoCount: properties.todos.length,
      });
    } else {
      this.log.info("Skipping todo.updated - session ID mismatch");
    }

    await this.actionExecutor.executeAll(actions);

    if (actions.length > 0) {
      this.log.info("Plan update complete");
    }
  }

  /**
   * Handle permission.asked events
   */
  private async handlePermissionAsked(properties: {
    id: string;
    sessionID: string;
    permission: string;
    [key: string]: unknown;
  }): Promise<void> {
    const actions = processPermissionAsked(properties, {
      opencodeSessionId: this.opencodeSessionId,
      workdir: this.workdir,
    });

    if (actions.length > 0) {
      this.log.info("Auto-approving permission", {
        requestId: properties.id,
        permission: properties.permission,
      });
    }

    await this.actionExecutor.executeAll(actions);
  }

  /**
   * Handle question.asked events
   */
  private async handleQuestionAsked(properties: {
    id: string;
    sessionID: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiple?: boolean;
    }>;
  }): Promise<PendingQuestion | null> {
    const result = processQuestionAsked(properties, this.handlerState, {
      linearSessionId: this.linearSessionId,
      opencodeSessionId: this.opencodeSessionId,
      workdir: this.workdir,
    });

    this.handlerState = result.state;

    if (result.pendingQuestion) {
      this.log.info("Question asked - posting elicitations to Linear", {
        requestId: properties.id,
        questionCount: properties.questions.length,
      });
    }

    await this.actionExecutor.executeAll(result.actions);

    return result.pendingQuestion ?? null;
  }

  /**
   * Handle session.idle - send completion response to Linear if needed
   *
   * If we already posted the agent's final text as a response, skip posting again.
   * Otherwise, post a default completion message.
   */
  private async handleSessionIdle(): Promise<void> {
    const postedFinalResponse = this.handlerState.postedFinalResponse;

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
  }): Promise<OpencodeEventResult> {
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
