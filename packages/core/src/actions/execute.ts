import type { Result } from "better-result";
import type { LinearService } from "../linear/LinearService";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { LinearServiceError, OpencodeServiceError } from "../errors";
import type { Action, LinearAction, OpencodeAction } from "./types";

export async function executeLinearAction(
  action: LinearAction,
  linear: LinearService,
): Promise<Result<void, LinearServiceError>> {
  switch (action.type) {
    case "postActivity":
      return linear.postActivity(
        action.sessionId,
        action.content,
        action.ephemeral,
      );
    case "postElicitation":
      return linear.postElicitation(
        action.sessionId,
        action.body,
        action.signal,
        action.metadata,
      );
    case "updatePlan":
      return linear.updatePlan(action.sessionId, action.plan);
    case "postError":
      return linear.postError(action.sessionId, action.error);
  }
}

export async function executeOpencodeAction(
  action: OpencodeAction,
  opencode: OpencodeService,
): Promise<Result<void, OpencodeServiceError>> {
  switch (action.type) {
    case "replyPermission":
      return opencode.replyPermission(
        action.requestId,
        action.reply,
        action.directory,
      );
    case "replyQuestion":
      return opencode.replyQuestion(
        action.requestId,
        action.answers,
        action.directory,
      );
  }
}

export async function executeLinearActions(
  actions: LinearAction[],
  linear: LinearService,
): Promise<void> {
  for (const action of actions) {
    await executeLinearAction(action, linear);
  }
}

function isLinearAction(action: Action): action is LinearAction {
  return (
    action.type === "postActivity" ||
    action.type === "postElicitation" ||
    action.type === "updatePlan" ||
    action.type === "postError"
  );
}

/**
 * Execute a mixed array of Actions, dispatching linear actions to the
 * LinearService and logging failures. OpenCode actions are skipped with
 * a warning — the plugin context cannot execute them.
 */
export async function executeActions(
  actions: Action[],
  linear: LinearService,
  log?: (message: string) => void,
): Promise<void> {
  for (const action of actions) {
    if (isLinearAction(action)) {
      const result = await executeLinearAction(action, linear);
      if (result.status === "error" && log) {
        log(`${action.type} failed: ${result.error.message}`);
      }
    } else if (log) {
      log(
        `Skipping opencode action ${action.type} — not supported in plugin context`,
      );
    }
  }
}
