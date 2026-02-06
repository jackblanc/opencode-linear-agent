/**
 * Orchestrator for routing OpenCode events to core's pure handler functions.
 *
 * Manages in-memory HandlerState per OpenCode session and executes
 * resulting actions against the LinearService.
 *
 * Uses the SDK's discriminated union on Event.type to narrow
 * event.properties automatically — no unsafe casts needed.
 */

import type { Event } from "@opencode-ai/sdk";
import type {
  EventMessagePartUpdated,
  EventSessionStatus,
  EventTodoUpdated,
  EventSessionError,
  EventQuestionAsked,
  ToolPart,
  TextPart,
} from "@opencode-ai/sdk/v2";
import {
  processToolPart,
  processTextPart,
  processSessionIdle,
  processTodoUpdated,
  processQuestionAsked,
  processSessionError,
  processPermissionAsked,
  executeActions,
  createInitialHandlerState,
  type HandlerState,
  type LinearService,
  type PendingQuestion,
  type PendingPermission,
  type SessionErrorProperties,
} from "@linear-opencode-agent/core";
import {
  getSessionAsync,
  savePendingQuestion,
  savePendingPermission,
} from "./storage";
import type { LinearContext } from "./storage";

export type Logger = (message: string) => void;

export type TokenReader = (organizationId: string) => Promise<string | null>;

export type LinearServiceFactory = (accessToken: string) => LinearService;

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
  linear: LinearContext,
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

interface ResolvedSession {
  ctx: SessionContext;
  linear: LinearService;
}

async function resolveSession(
  opencodeSessionId: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
): Promise<ResolvedSession | null> {
  const session = await getSessionAsync(opencodeSessionId);
  if (!session?.linear.sessionId) return null;

  const ctx = toSessionContext(opencodeSessionId, session.linear);
  if (!ctx) return null;

  const token = await readToken(session.linear.organizationId);
  if (!token) return null;

  return { ctx, linear: createService(token) };
}

export async function handleEvent(
  event: Event,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  // Widen the type to string to handle v2 event types not in base SDK's Event union.
  // Runtime safety is ensured by checking eventType before each cast.
  const eventType: string = event.type;

  if (eventType === "message.part.updated") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventMessagePartUpdated;
    return handlePartUpdated(typedEvent, readToken, createService, log);
  }
  if (eventType === "session.status") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventSessionStatus;
    return handleSessionStatus(typedEvent, readToken, createService, log);
  }
  if (eventType === "todo.updated") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventTodoUpdated;
    return handleTodoUpdated(typedEvent, readToken, createService, log);
  }
  if (eventType === "session.error") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventSessionError;
    return handleSessionErrorEvent(typedEvent, readToken, createService, log);
  }
  if (eventType === "question.asked") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventQuestionAsked;
    return handleQuestionAsked(typedEvent, readToken, createService, log);
  }
}

async function handlePartUpdated(
  event: EventMessagePartUpdated,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const part = event.properties.part;
  if (!("sessionID" in part)) return;

  const resolved = await resolveSession(
    part.sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const state = getHandlerState(part.sessionID);

  if (isToolPart(part)) {
    const result = processToolPart(part, state, resolved.ctx);
    updateHandlerState(part.sessionID, result.state);
    await executeActions(result.actions, resolved.linear, log);
    return;
  }

  if (isTextPart(part)) {
    const result = processTextPart(part, state, resolved.ctx);
    updateHandlerState(part.sessionID, result.state);
    await executeActions(result.actions, resolved.linear, log);
    return;
  }
}

async function handleSessionStatus(
  event: EventSessionStatus,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  if (event.properties.status.type !== "idle") return;

  const sessionID = event.properties.sessionID;
  const resolved = await resolveSession(sessionID, readToken, createService);
  if (!resolved) return;

  const state = getHandlerState(sessionID);
  const result = processSessionIdle(state, resolved.ctx);
  updateHandlerState(sessionID, result.state);
  await executeActions(result.actions, resolved.linear, log);

  // Clean up handler state so resumed sessions start fresh
  handlerStates.delete(sessionID);
}

async function handleTodoUpdated(
  event: EventTodoUpdated,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const { sessionID, todos } = event.properties;

  const resolved = await resolveSession(sessionID, readToken, createService);
  if (!resolved) return;

  const actions = processTodoUpdated({ sessionID, todos }, resolved.ctx);
  await executeActions(actions, resolved.linear, log);
}

async function handleSessionErrorEvent(
  event: EventSessionError,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const sessionID = event.properties.sessionID;
  if (!sessionID) return;

  const resolved = await resolveSession(sessionID, readToken, createService);
  if (!resolved) return;

  const state = getHandlerState(sessionID);
  const errorProps: SessionErrorProperties = {
    sessionID,
    error: event.properties.error,
  };
  const result = processSessionError(errorProps, state, resolved.ctx);
  updateHandlerState(sessionID, result.state);
  await executeActions(result.actions, resolved.linear, log);
}

async function handleQuestionAsked(
  event: EventQuestionAsked,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const { id, sessionID, questions } = event.properties;

  const resolved = await resolveSession(sessionID, readToken, createService);
  if (!resolved) return;

  const result = processQuestionAsked(id, questions, resolved.ctx);
  await executeActions(result.actions, resolved.linear, log);
  await persistPendingQuestion(result.pendingQuestion);
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
  log: Logger,
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
    },
    ctx,
  );
  await executeActions(result.actions, linear, log);
  await persistPendingPermission(result.pendingPermission);
}
