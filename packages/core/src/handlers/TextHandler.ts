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
 * Text parts are posted as response activities when complete.
 * We detect completion by checking if time.end is set.
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

  // Create new state with this part marked as sent and final response posted
  const newState: HandlerState = {
    ...state,
    sentTextParts: new Set([...state.sentTextParts, id]),
    postedFinalResponse: true,
  };

  // Post response activity
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
