import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";

/**
 * Context needed for text handler processing
 */
export interface TextHandlerContext {
  linearSessionId: string;
}

/**
 * Process session idle event - pure function
 *
 * When the session becomes idle, post the final assistant text as a
 * "response" activity to mark the session as complete on Linear.
 *
 * The caller owns event ordering and deduplication across invocations.
 * This handler only skips empty text.
 *
 * Returns actions with unchanged state.
 * No side effects, no I/O.
 */
export function processSessionIdle(
  text: string,
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  if (!text.trim()) {
    return { state, actions: [] };
  }

  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "response", body: text.trim() },
      ephemeral: false,
    },
  ];

  return { state, actions };
}
