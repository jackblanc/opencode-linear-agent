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
 * Text parts are stored but not immediately posted. The last text
 * content is posted as a "response" activity when the session goes
 * idle, reducing notification noise for intermediate text.
 *
 * We detect completion by checking if time.end is set.
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
export function processTextPart(
  part: TextPart,
  state: HandlerState,
  _ctx: TextHandlerContext,
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

  // Skip if already processed (check AFTER confirming it's complete)
  if (state.sentTextParts.has(id)) {
    return { state, actions: [] };
  }

  // Store the text content for posting when session goes idle
  // Each new text part overwrites the previous - we only post the last one
  const newState: HandlerState = {
    ...state,
    sentTextParts: new Set([...state.sentTextParts, id]),
    lastTextContent: text,
  };

  // No actions - text will be posted on session idle
  return { state: newState, actions: [] };
}

/**
 * Process session idle event - post final response
 *
 * When the session goes idle, we post the last text content as a
 * "response" activity. This ensures only one notification is sent
 * for the final response rather than for each intermediate text part.
 */
export function processSessionIdle(
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  const text = state.lastTextContent;

  // Nothing to post
  if (!text) {
    return { state, actions: [] };
  }

  // Already posted final response
  if (state.postedFinalResponse) {
    return { state, actions: [] };
  }

  const newState: HandlerState = {
    ...state,
    lastTextContent: null,
    postedFinalResponse: true,
  };

  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "response", body: text },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}
