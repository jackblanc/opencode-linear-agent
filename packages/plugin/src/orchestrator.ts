import type {
  Event,
  EventMessagePartUpdated,
  EventSessionIdle,
  EventTodoUpdated,
  EventSessionError,
  EventQuestionAsked,
  ReasoningPart,
  ToolPart,
  Part,
  TextPart,
  EventPermissionAsked,
} from "@opencode-ai/sdk/v2";
import {
  processToolPart,
  processReasoningPart,
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

type TokenReader = (organizationId: string) => Promise<string | null>;

type LinearServiceFactory = (accessToken: string) => LinearService;

type SessionMessagesReader = (
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

function isReasoningPart(part: { type: string }): part is ReasoningPart {
  return part.type === "reasoning";
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
  if (event.type === "message.part.updated") {
    return handlePartUpdated(event, workdir, readToken, createService, log);
  }

  if (event.type === "session.idle") {
    return handleSessionIdle(
      event,
      workdir,
      readSessionMessages,
      readToken,
      createService,
      log,
    );
  }

  if (event.type === "todo.updated") {
    return handleTodoUpdated(event, workdir, readToken, createService, log);
  }

  if (event.type === "session.error") {
    return handleSessionErrorEvent(
      event,
      workdir,
      readToken,
      createService,
      log,
    );
  }

  if (event.type === "question.asked") {
    return handleQuestionAsked(event, workdir, readToken, createService, log);
  }

  if (event.type === "permission.asked") {
    await handlePermissionAsked(event, workdir, readToken, createService, log);
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

  if (isReasoningPart(part)) {
    const result = processReasoningPart(part, state, resolved.ctx);
    await executeActions(result.actions, resolved.linear, log);
    return;
  }

  if (isTextPart(part)) {
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
  const result = processSessionIdle(text, state, resolved.ctx);
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

async function handlePermissionAsked(
  event: EventPermissionAsked,
  workdir: string,
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const { id, sessionID, patterns, permission, metadata } = event.properties;

  const resolved = await resolveSession(
    workdir,
    sessionID,
    readToken,
    createService,
  );
  if (!resolved) return;

  const result = processPermissionAsked(
    {
      id,
      sessionID,
      permission,
      patterns,
      metadata,
    },
    resolved.ctx,
  );
  await executeActions(result.actions, resolved.linear, log);
  await persistPendingPermission(result.pendingPermission);
}
