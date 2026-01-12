import { Result } from "better-result";
import type { LinearService } from "../linear/LinearService";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { LinearServiceError, OpencodeServiceError } from "../errors";
import type { Logger } from "../logger";
import { Log } from "../logger";
import type { OpencodeAction } from "./types";

/**
 * Error from executing an action
 */
export type ActionExecutionError = LinearServiceError | OpencodeServiceError;

/**
 * Result of executing an action
 */
export interface ActionResult {
  action: OpencodeAction;
  result: Result<void, ActionExecutionError>;
}

/**
 * Executes actions emitted by event processors
 *
 * This decouples "what to do" from "how to do it" per AGENTS.md design principles.
 * Pure processing functions return actions, which are then executed here.
 */
export class ActionExecutor {
  private readonly log: Logger;

  constructor(
    private readonly linear: LinearService,
    private readonly opencode: OpencodeService,
  ) {
    this.log = Log.create({ service: "action-executor" });
  }

  /**
   * Execute a single action
   */
  async execute(
    action: OpencodeAction,
  ): Promise<Result<void, ActionExecutionError>> {
    switch (action.type) {
      case "postActivity":
        return this.linear.postActivity(
          action.sessionId,
          action.content,
          action.ephemeral,
        );

      case "postElicitation":
        return this.linear.postElicitation(
          action.sessionId,
          action.body,
          action.signal,
          action.metadata,
        );

      case "updatePlan":
        return this.linear.updatePlan(action.sessionId, action.plan);

      case "replyPermission":
        return this.opencode.replyPermission(
          action.requestId,
          action.reply,
          action.directory,
        );

      case "replyQuestion":
        return this.opencode.replyQuestion(
          action.requestId,
          action.answers,
          action.directory,
        );

      case "postError":
        return this.linear.postError(action.sessionId, action.error);
    }
  }

  /**
   * Execute multiple actions and return results
   *
   * Actions are executed sequentially to preserve ordering.
   * All actions are attempted even if earlier ones fail (recoverable error pattern).
   */
  async executeAll(actions: OpencodeAction[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const action of actions) {
      const result = await this.execute(action);

      if (Result.isError(result)) {
        this.log.warn("Action execution failed", {
          actionType: action.type,
          error: result.error.message,
          errorTag: result.error._tag,
        });
      }

      results.push({ action, result });
    }

    return results;
  }

  /**
   * Execute actions and return true if all succeeded
   */
  async executeAllOk(actions: OpencodeAction[]): Promise<boolean> {
    const results = await this.executeAll(actions);
    return results.every((r) => Result.isOk(r.result));
  }
}
