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
 * When the session becomes idle (processing complete), post the latest
 * assistant text as a "response" activity to mark the session as complete on Linear.
 *
 * Guards:
 * - Skip if already posted a final response (defense-in-depth)
 * - Skip if an error was already posted (session is in error state)
 * - Skip if no text was processed (tool-only session)
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
export function processSessionIdle(
  text: string,
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  if (state.postedFinalResponse || state.postedError) {
    return { state, actions: [] };
  }

  if (!text.trim()) {
    return { state, actions: [] };
  }

  const newState: HandlerState = {
    ...state,
    postedFinalResponse: true,
  };

  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "response", body: text.trim() },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}
