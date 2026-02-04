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
 * The final response is posted when the message completes (see processMessageCompleted).
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
export function processTextPart(
  part: TextPart,
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  const { id, messageID, text, time } = part;

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

  // Track last text part for this message - used for final response
  const newLastTextParts = new Map(state.lastTextParts);
  newLastTextParts.set(messageID, { partId: id, text: text.trim() });

  // Create new state with this part marked as sent
  const newState: HandlerState = {
    ...state,
    sentTextParts: new Set([...state.sentTextParts, id]),
    lastTextParts: newLastTextParts,
  };

  // Post as thought (no notification) - final response posted when message completes
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
 * Process message completion - pure function
 *
 * When a message completes (time.completed is set), post the last text part
 * as a "response" activity to trigger notification.
 *
 * Takes current state and returns new state + actions.
 * No side effects, no I/O.
 */
export function processMessageCompleted(
  messageId: string,
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  // Check if we already posted a final response
  if (state.postedFinalResponse) {
    return { state, actions: [] };
  }

  // Get the last text part for this message
  const lastText = state.lastTextParts.get(messageId);
  if (!lastText) {
    return { state, actions: [] };
  }

  // Mark final response as posted
  const newState: HandlerState = {
    ...state,
    postedFinalResponse: true,
  };

  // Post as response (triggers notification)
  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "response", body: lastText.text },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}
