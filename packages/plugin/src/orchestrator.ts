import type { Event } from "@opencode-ai/sdk";
import type {
  EventMessagePartUpdated,
  EventSessionIdle,
  EventTodoUpdated,
  EventSessionError,
  EventQuestionAsked,
  ToolPart,
  Part,
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
  type LinearService,
  type PendingQuestion,
  type PendingPermission,
  type SessionErrorProperties,
} from "@opencode-linear-agent/core";
import {
  getSessionAsync,
  savePendingQuestion,
  savePendingPermission,
} from "./storage";
import type { LinearContext } from "./storage";

export type Logger = (message: string) => void;

export type TokenReader = (organizationId: string) => Promise<string | null>;

export type LinearServiceFactory = (accessToken: string) => LinearService;

export type SessionMessagesReader = (
  sessionId: string,
) => Promise<Array<{ info: { role: string; error?: unknown }; parts: Part[] }>>;

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
  workdir: string,
  opencodeSessionId: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
): Promise<ResolvedSession | null> {
  const session = await getSessionAsync(workdir);
  if (!session?.sessionId) return null;

  const ctx = toSessionContext(opencodeSessionId, session);
  if (!ctx) return null;

  const token = await readToken(session.organizationId);
  if (!token) return null;

  return { ctx, linear: createService(token) };
}

function extractLatestAssistantText(
  messages: Array<{ info: { role: string; error?: unknown }; parts: Part[] }>,
): string | null {
  const m = messages[messages.length - 1];
  if (m?.info.role !== "assistant" || m.info.error) {
    return null;
  }

  const chunks: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text" && p.text.trim()) {
      chunks.push(p.text.trim());
    }
  }

  if (chunks.length === 0) {
    return null;
  }
  return chunks.join("\n\n");
}

export async function handleEvent(
  event: Event,
  workdir: string,
  readSessionMessages: SessionMessagesReader,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const eventType: string = event.type;

  if (eventType === "message.part.updated") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventMessagePartUpdated;
    return handlePartUpdated(
      typedEvent,
      workdir,
      readToken,
      createService,
      log,
    );
  }

  if (eventType === "session.idle") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventSessionIdle;
    return handleSessionIdle(
      typedEvent,
      workdir,
      readSessionMessages,
      readToken,
      createService,
      log,
    );
  }

  if (eventType === "todo.updated") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventTodoUpdated;
    return handleTodoUpdated(
      typedEvent,
      workdir,
      readToken,
      createService,
      log,
    );
  }

  if (eventType === "session.error") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventSessionError;
    return handleSessionErrorEvent(
      typedEvent,
      workdir,
      readToken,
      createService,
      log,
    );
  }

  if (eventType === "question.asked") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Checked by eventType guard above
    const typedEvent = event as unknown as EventQuestionAsked;
    return handleQuestionAsked(
      typedEvent,
      workdir,
      readToken,
      createService,
      log,
    );
  }
}

async function handlePartUpdated(
  event: EventMessagePartUpdated,
  workdir: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const part = event.properties.part;
  if (!("sessionID" in part)) return;

  const resolved = await resolveSession(
    workdir,
    part.sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const state = createInitialHandlerState();

  if (isToolPart(part)) {
    const result = processToolPart(part, state, resolved.ctx);
    await executeActions(result.actions, resolved.linear, log);
    return;
  }

  if (isTextPart(part)) {
    const result = processTextPart(part, state, resolved.ctx);
    await executeActions(result.actions, resolved.linear, log);
    return;
  }
}

async function handleSessionIdle(
  event: EventSessionIdle,
  workdir: string,
  readSessionMessages: SessionMessagesReader,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const sessionID = event.properties.sessionID;
  const resolved = await resolveSession(
    workdir,
    sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const messages = await readSessionMessages(sessionID);
  const text = extractLatestAssistantText(messages);
  if (!text) return;

  const state = createInitialHandlerState();
  state.latestResponseText = text;
  const result = processSessionIdle(state, resolved.ctx);
  await executeActions(result.actions, resolved.linear, log);
}

async function handleTodoUpdated(
  event: EventTodoUpdated,
  workdir: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const { sessionID, todos } = event.properties;

  const resolved = await resolveSession(
    workdir,
    sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const actions = processTodoUpdated({ sessionID, todos }, resolved.ctx);
  await executeActions(actions, resolved.linear, log);
}

async function handleSessionErrorEvent(
  event: EventSessionError,
  workdir: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const sessionID = event.properties.sessionID;
  if (!sessionID) return;

  const resolved = await resolveSession(
    workdir,
    sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const state = createInitialHandlerState();
  const errorProps: SessionErrorProperties = {
    sessionID,
    error: event.properties.error,
  };
  const result = processSessionError(errorProps, state, resolved.ctx);
  await executeActions(result.actions, resolved.linear, log);
}

async function handleQuestionAsked(
  event: EventQuestionAsked,
  workdir: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const { id, sessionID, questions } = event.properties;

  const resolved = await resolveSession(
    workdir,
    sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const result = processQuestionAsked(id, questions, resolved.ctx);
  await executeActions(result.actions, resolved.linear, log);
  await persistPendingQuestion(result.pendingQuestion);
}

export async function handlePermissionAskHook(
  workdir: string,
  sessionId: string,
  requestId: string,
  permission: string,
  patterns: string[],
  metadata: Record<string, unknown>,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  const session = await getSessionAsync(workdir);
  if (!session?.sessionId) return;

  const ctx = toSessionContext(sessionId, session);
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
