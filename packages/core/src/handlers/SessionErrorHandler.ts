import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";

/**
 * Context needed for session error handler processing
 */
export interface SessionErrorHandlerContext {
  linearSessionId: string;
}

/**
 * Properties from session.error event
 */
export interface SessionErrorProperties {
  sessionID: string;
  error?: {
    name?: string;
    data?: { message?: string };
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Process a session.error event - pure function
 *
 * Posts an error activity to Linear. Only posts once per session
 * (deduplicates using postedError flag in HandlerState).
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
export function processSessionError(
  properties: SessionErrorProperties,
  state: HandlerState,
  ctx: SessionErrorHandlerContext,
): HandlerResult<HandlerState> {
  if (state.postedError) {
    return { state, actions: [] };
  }

  let message = "Unknown error";
  if (
    properties.error?.data &&
    "message" in properties.error.data &&
    isString(properties.error.data.message)
  ) {
    message = properties.error.data.message;
  } else if (properties.error?.name) {
    message = properties.error.name;
  }

  const newState: HandlerState = {
    ...state,
    postedError: true,
  };

  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "error", body: `**Error:** ${message}` },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}
