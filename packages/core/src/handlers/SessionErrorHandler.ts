import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResult } from "../actions/types";

export interface SessionErrorProperties {
  sessionID?: string;
  error?: unknown;
}

export interface SessionErrorHandlerContext {
  linearSessionId: string;
  opencodeSessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (!isRecord(error)) {
    if (typeof error === "string") return error;
    if (typeof error === "number" || typeof error === "boolean") {
      return String(error);
    }
    if (typeof error === "bigint") return error.toString();
    if (typeof error === "symbol") return error.description ?? "Unknown error";
    return "Unknown error";
  }

  const data = error["data"];
  if (isRecord(data)) {
    const messageValue = data["message"];
    if (typeof messageValue === "string" && messageValue.trim()) {
      return messageValue;
    }
  }

  const nameValue = error["name"];
  if (typeof nameValue === "string" && nameValue.trim()) {
    return nameValue;
  }

  return "Unknown error";
}

export function processSessionError(
  properties: SessionErrorProperties,
  state: HandlerState,
  ctx: SessionErrorHandlerContext,
): HandlerResult<HandlerState> {
  if (properties.sessionID !== ctx.opencodeSessionId) {
    return { state, actions: [] };
  }

  if (state.postedError) {
    return { state, actions: [] };
  }

  const message = getErrorMessage(properties.error);

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
