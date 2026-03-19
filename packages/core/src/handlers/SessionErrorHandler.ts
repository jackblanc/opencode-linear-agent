import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";
import type { EventSessionError } from "@opencode-ai/sdk/v2";

/**
 * TODO: Each handler defines "Context" that is basically just linearSessionId repeated a million times
 *
 * Context needed for session error handler processing
 */
interface SessionErrorHandlerContext {
  linearSessionId: string;
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
  event: EventSessionError,
  state: HandlerState,
  ctx: SessionErrorHandlerContext,
): HandlerResult<HandlerState> {
  if (state.postedError) {
    return { state, actions: [] };
  }

  const errorName = event.properties.error?.name ?? "UndefinedError";
  const errorMessage =
    event.properties.error?.data.message ?? "No error message provided";
  const errorData = JSON.stringify(event.properties.error?.data ?? {});

  const newState: HandlerState = {
    ...state,
    postedError: true,
  };

  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: {
        type: "error",
        body: `**Error: ${errorName}**\n${errorMessage}\n\`\`\`json\n${errorData}\n\`\`\``,
      },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}
