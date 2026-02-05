/**
 * Orchestrator for routing OpenCode events to core's pure handler functions.
 *
 * Manages in-memory HandlerState per OpenCode session and executes
 * resulting LinearActions against the LinearService.
 */

import type { Event } from "@opencode-ai/sdk";
import type { ToolPart, TextPart, Todo } from "@opencode-ai/sdk/v2";
import {
  processToolPart,
  processTextPart,
  processMessageCompleted,
  processTodoUpdated,
  processQuestionFromTool,
  processSessionError,
  processPermissionAsked,
  isQuestionTool,
  executeLinearActions,
  createInitialHandlerState,
  type HandlerState,
  type LinearService,
  type LinearAction,
  type PendingQuestion,
  type PendingPermission,
  type SessionErrorProperties,
} from "@linear-opencode-agent/core";
import {
  getSessionAsync,
  savePendingQuestion,
  savePendingPermission,
  type PluginSessionState,
} from "./storage";

export type Logger = (message: string) => void;

const handlerStates = new Map<string, HandlerState>();

function getHandlerState(sessionId: string): HandlerState {
  let state = handlerStates.get(sessionId);
  if (!state) {
    state = createInitialHandlerState();
    handlerStates.set(sessionId, state);
  }
  return state;
}

function updateHandlerState(sessionId: string, state: HandlerState): void {
  handlerStates.set(sessionId, state);
}

interface SessionContext {
  linearSessionId: string;
  opencodeSessionId: string;
  workdir: string;
  issueId: string;
}

function toSessionContext(
  opencodeSessionId: string,
  linear: PluginSessionState["linear"],
): SessionContext | null {
  if (!linear.sessionId) return null;
  return {
    linearSessionId: linear.sessionId,
    opencodeSessionId,
    workdir: linear.workdir,
    issueId: linear.issueId,
  };
}

async function persistPendingQuestion(
  question: PendingQuestion | undefined,
): Promise<void> {
  if (question) {
    await savePendingQuestion(question);
  }
}

async function persistPendingPermission(
  permission: PendingPermission | undefined,
): Promise<void> {
  if (permission) {
    await savePendingPermission(permission);
  }
}

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type === "tool";
}

function isTextPart(part: { type: string }): part is TextPart {
  return part.type === "text";
}

interface AssistantMessageInfo {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
}

function isCompletedAssistantMessage(
  info: unknown,
): info is AssistantMessageInfo {
  if (!info || typeof info !== "object") return false;
  if (!("role" in info) || !("time" in info)) return false;
  if (info.role !== "assistant") return false;
  const time = (info as { time: unknown }).time;
  if (!time || typeof time !== "object") return false;
  return "completed" in time && !!(time as { completed: unknown }).completed;
}

/**
 * Cast event.properties for events where we've already checked event.type.
 * The SDK Event union doesn't discriminate properties by event.type,
 * so we need unsafe casts after the type guard.
 */
type EventProps = Record<string, unknown>;

function props(event: Event): EventProps {
  return event.properties as EventProps;
}

export async function handleEvent(
  event: Event,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  if (event.type === "message.part.updated") {
    await handlePartUpdated(event, linear, log);
    return;
  }

  if (event.type === "message.updated") {
    await handleMessageUpdated(event, linear);
    return;
  }

  if (event.type === "todo.updated") {
    await handleTodoUpdated(event, linear);
    return;
  }

  if (event.type === "session.error") {
    await handleSessionErrorEvent(event, linear);
    return;
  }
}

async function handlePartUpdated(
  event: Event,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  const p = props(event);
  const part = p.part as { type: string; sessionID?: string } | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Event properties narrowed by event.type check
  if (!part?.sessionID) return;

  const sessionId = part.sessionID;
  const session = await getSessionAsync(sessionId);
  if (!session?.linear.sessionId) return;

  const ctx = toSessionContext(sessionId, session.linear);
  if (!ctx) return;

  const state = getHandlerState(sessionId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by isToolPart/isTextPart guards
  if (isToolPart(part as ToolPart)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by isToolPart
    const toolPart = part as unknown as ToolPart;

    if (isQuestionTool(toolPart.tool) && toolPart.state.status === "running") {
      const result = processQuestionFromTool(
        toolPart.callID,
        toolPart.state.input,
        state,
        ctx,
      );
      updateHandlerState(sessionId, result.state);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
      await executeLinearActions(result.actions as LinearAction[], linear);
      await persistPendingQuestion(result.pendingQuestion);
      log(
        `Question tool: ${toolPart.tool} (callId=${toolPart.callID}, actions=${result.actions.length})`,
      );
      return;
    }

    const result = processToolPart(toolPart, state, ctx);
    updateHandlerState(sessionId, result.state);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
    await executeLinearActions(result.actions as LinearAction[], linear);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by isTextPart guard
  if (isTextPart(part as TextPart)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by isTextPart
    const textPart = part as unknown as TextPart;
    const result = processTextPart(textPart, state, ctx);
    updateHandlerState(sessionId, result.state);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
    await executeLinearActions(result.actions as LinearAction[], linear);
    return;
  }
}

async function handleMessageUpdated(
  event: Event,
  linear: LinearService,
): Promise<void> {
  const p = props(event);
  if (!isCompletedAssistantMessage(p.info)) return;

  const info = p.info;
  const session = await getSessionAsync(info.sessionID);
  if (!session?.linear.sessionId) return;

  const ctx = toSessionContext(info.sessionID, session.linear);
  if (!ctx) return;

  const state = getHandlerState(info.sessionID);
  const result = processMessageCompleted(info.id, state, ctx);
  updateHandlerState(info.sessionID, result.state);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
  await executeLinearActions(result.actions as LinearAction[], linear);
}

async function handleTodoUpdated(
  event: Event,
  linear: LinearService,
): Promise<void> {
  const p = props(event);
  const sessionID = p.sessionID as string | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Event properties narrowed by event.type check
  const todos = p.todos as Todo[] | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Event properties narrowed by event.type check
  if (!sessionID || !todos) return;

  const session = await getSessionAsync(sessionID);
  if (!session?.linear.sessionId) return;

  const ctx = toSessionContext(sessionID, session.linear);
  if (!ctx) return;

  const actions = processTodoUpdated({ sessionID, todos }, ctx);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
  await executeLinearActions(actions as LinearAction[], linear);
}

async function handleSessionErrorEvent(
  event: Event,
  linear: LinearService,
): Promise<void> {
  const p = props(event);
  const sessionID = p.sessionID as string | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Event properties narrowed by event.type check
  if (!sessionID) return;

  const session = await getSessionAsync(sessionID);
  if (!session?.linear.sessionId) return;

  const ctx = toSessionContext(sessionID, session.linear);
  if (!ctx) return;

  const state = getHandlerState(sessionID);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Event properties match SessionErrorProperties after type check
  const errorProps = p as unknown as SessionErrorProperties;
  const result = processSessionError(errorProps, state, ctx);
  updateHandlerState(sessionID, result.state);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
  await executeLinearActions(result.actions as LinearAction[], linear);
}

/**
 * Handle permission.ask hook - called from plugin.ts
 */
export async function handlePermissionAskHook(
  sessionId: string,
  requestId: string,
  permission: string,
  patterns: string[],
  metadata: Record<string, unknown>,
  linear: LinearService,
): Promise<void> {
  const session = await getSessionAsync(sessionId);
  if (!session?.linear.sessionId) return;

  const ctx = toSessionContext(sessionId, session.linear);
  if (!ctx) return;

  const result = processPermissionAsked(
    {
      id: requestId,
      sessionID: sessionId,
      permission,
      patterns,
      metadata,
      always: [],
    },
    ctx,
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
  await executeLinearActions(result.actions as LinearAction[], linear);
  await persistPendingPermission(result.pendingPermission);
}

/**
 * Handle tool.execute.before hook for question tools - called from plugin.ts
 */
export async function handleQuestionToolHook(
  sessionId: string,
  callId: string,
  args: unknown,
  linear: LinearService,
): Promise<void> {
  const session = await getSessionAsync(sessionId);
  if (!session?.linear.sessionId) return;

  const ctx = toSessionContext(sessionId, session.linear);
  if (!ctx) return;

  const state = getHandlerState(sessionId);
  const result = processQuestionFromTool(callId, args, state, ctx);
  updateHandlerState(sessionId, result.state);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler only returns LinearActions
  await executeLinearActions(result.actions as LinearAction[], linear);
  await persistPendingQuestion(result.pendingQuestion);
}
