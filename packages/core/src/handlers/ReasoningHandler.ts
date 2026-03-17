import type { ReasoningPart } from "@opencode-ai/sdk/v2";
import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";

interface ReasoningHandlerContext {
  linearSessionId: string;
}

export function processReasoningPart(
  part: ReasoningPart,
  state: HandlerState,
  ctx: ReasoningHandlerContext,
): HandlerResult<HandlerState> {
  if (!part.time?.end) {
    return { state, actions: [] };
  }

  if (!part.text.trim()) {
    return { state, actions: [] };
  }

  const actions: Action[] = [
    {
      type: "postActivity",
      sessionId: ctx.linearSessionId,
      content: { type: "thought", body: part.text.trim() },
      ephemeral: true,
    },
  ];

  return { state, actions };
}
