import type { TextPart, AssistantMessage } from "@opencode-ai/sdk/v2";
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
 * Text parts are posted as "thought" activities when complete, and the
 * text content is stored per-message for posting as "response" when the
 * message completes (time.completed is set).
 *
 * We detect text completion by checking if time.end is set on the part.
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

  // Skip if already processed (check AFTER confirming it's complete)
  if (state.sentTextParts.has(id)) {
    return { state, actions: [] };
  }

  // Store the text content for this message - will be posted as "response" when message completes
  const newLastTextByMessage = new Map(state.lastTextByMessage);
  newLastTextByMessage.set(messageID, text);

  const newState: HandlerState = {
    ...state,
    sentTextParts: new Set([...state.sentTextParts, id]),
    lastTextByMessage: newLastTextByMessage,
  };

  // Post intermediate text as "thought" so it appears in Linear
  // The final text will be posted as "response" when message completes
  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "thought", body: text },
      ephemeral: false,
    },
  ];

  return { state: newState, actions };
}

/**
 * Process message.updated event - post final response when message completes
 *
 * When an AssistantMessage has time.completed set, we post the last text
 * content for that message as a "response" activity. This ensures only
 * one notification is sent for the final response.
 */
export function processMessageCompleted(
  message: AssistantMessage,
  state: HandlerState,
  ctx: TextHandlerContext,
): HandlerResult<HandlerState> {
  // Only process if message has completed
  if (!message.time.completed) {
    return { state, actions: [] };
  }

  // Skip if already processed this message
  if (state.completedMessages.has(message.id)) {
    return { state, actions: [] };
  }

  // Skip if we already posted a final response
  if (state.postedFinalResponse) {
    return { state, actions: [] };
  }

  const text = state.lastTextByMessage.get(message.id);

  // Mark message as completed and clean up
  const newLastTextByMessage = new Map(state.lastTextByMessage);
  newLastTextByMessage.delete(message.id);

  const newState: HandlerState = {
    ...state,
    completedMessages: new Set([...state.completedMessages, message.id]),
    lastTextByMessage: newLastTextByMessage,
    postedFinalResponse: text ? true : state.postedFinalResponse,
  };

  // Nothing to post if no text for this message
  if (!text) {
    return { state: newState, actions: [] };
  }

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
