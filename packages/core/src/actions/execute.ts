import type { Result } from "better-result";
import type { LinearService } from "../linear/LinearService";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { LinearServiceError, OpencodeServiceError } from "../errors";
import type { LinearAction, OpencodeAction } from "./types";

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
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
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
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
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
