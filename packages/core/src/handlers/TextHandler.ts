import type { TextPart } from "@opencode-ai/sdk/v2";
import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";

/**
 * Context needed for text handler processing
 */
export interface TextHandlerContext {
  linearSessionId: string;
}

/**
 * Process a text part event - pure function
 *
 * Intermediate text parts are posted as "thought" activities (no notification).
 * The final response is posted when the session goes idle (see processSessionIdle).
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
export function processTextPart(
  part: TextPart,
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  const { id, text, time } = part;

  // Skip empty text
  if (!text.trim()) {
    return { state, actions: [] };
  }

  // Only process complete text parts (has end time)
  // Streaming parts arrive without time.end, we wait for the final update
  if (!time?.end) {
    return { state, actions: [] };
  }

  // Skip if already sent (check AFTER confirming it's complete)
  // This prevents posting the same completed text twice
  if (state.sentTextParts.has(id)) {
    return { state, actions: [] };
  }

  // Create new state with this part marked as sent and latest text tracked
  const newState: HandlerState = {
    ...state,
    sentTextParts: new Set([...state.sentTextParts, id]),
    latestResponseText: text.trim(),
  };

  // Post as thought (no notification) - final response posted on session idle
  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "thought", body: text },
      ephemeral: true,
    },
  ];

  return { state: newState, actions };
}

/**
 * Process session idle event - pure function
 *
 * When the session becomes idle (processing complete), post the latest
 * text as a "response" activity to mark the session as complete on Linear.
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
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  if (state.postedFinalResponse || state.postedError) {
    return { state, actions: [] };
  }

  if (!state.latestResponseText) {
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
      content: { type: "response", body: state.latestResponseText },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}
