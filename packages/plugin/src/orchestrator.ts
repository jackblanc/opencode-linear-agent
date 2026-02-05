import type {
  PermissionRequest,
  QuestionRequest,
  TextPart,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  createInitialHandlerState,
  executeLinearActions,
  processMessageCompleted,
  processPermissionAsked,
  processQuestionAsked,
  processQuestionFromTool,
  processSessionError,
  processTextPart,
  processTodoUpdated,
  processToolPart,
  type Action,
  type HandlerState,
  type LinearAction,
  type SessionErrorProperties,
  type TodoUpdatedProperties,
} from "@linear-opencode-agent/core";
import type { LinearService } from "@linear-opencode-agent/core";
import {
  getSessionAsync,
  savePendingPermission,
  savePendingQuestion,
} from "./storage";

type OpencodeEvent = {
  type: string;
  properties: unknown;
};

interface AssistantMessageInfo {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    completed?: number;
  };
}

const handlerStates = new Map<string, HandlerState>();

function getHandlerState(sessionId: string): HandlerState {
  const existing = handlerStates.get(sessionId);
  if (existing) return existing;

  const initial = createInitialHandlerState();
  handlerStates.set(sessionId, initial);
  return initial;
}

function updateHandlerState(sessionId: string, state: HandlerState): void {
  handlerStates.set(sessionId, state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolPart(value: unknown): value is ToolPart {
  return isRecord(value) && value["type"] === "tool";
}

function isTextPart(value: unknown): value is TextPart {
  return isRecord(value) && value["type"] === "text";
}

function isQuestionTool(tool: string): boolean {
  const toolLower = tool.toLowerCase();
  return toolLower === "question" || toolLower.endsWith("_question");
}

function isAssistantMessageInfo(value: unknown): value is AssistantMessageInfo {
  if (!isRecord(value)) return false;
  if (value["role"] !== "assistant") return false;
  if (!isRecord(value["time"])) return false;
  return (
    typeof value["id"] === "string" && typeof value["sessionID"] === "string"
  );
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string") return false;
  if (typeof value["sessionID"] !== "string") return false;
  if (typeof value["permission"] !== "string") return false;
  if (!Array.isArray(value["patterns"])) return false;
  return isRecord(value["metadata"]);
}

function isQuestionRequest(value: unknown): value is QuestionRequest {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string") return false;
  if (typeof value["sessionID"] !== "string") return false;
  return Array.isArray(value["questions"]);
}

function toSessionErrorProperties(
  value: unknown,
): SessionErrorProperties | null {
  if (!isRecord(value)) return null;
  const sessionID = value["sessionID"];
  const error = value["error"];
  return {
    sessionID: typeof sessionID === "string" ? sessionID : undefined,
    error,
  };
}

function toTodoUpdatedProperties(value: unknown): TodoUpdatedProperties | null {
  if (!isRecord(value)) return null;
  const sessionID = value["sessionID"];
  const todos = value["todos"];
  if (typeof sessionID !== "string" || !Array.isArray(todos)) return null;

  const todoList = todos.filter((todo): todo is Todo => {
    if (!isRecord(todo)) return false;
    return (
      typeof todo["content"] === "string" &&
      typeof todo["status"] === "string" &&
      typeof todo["id"] === "string"
    );
  });

  if (todoList.length !== todos.length) return null;
  return { sessionID, todos: todoList };
}

function filterLinearActions(actions: Action[]): LinearAction[] {
  const linear: LinearAction[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "postActivity":
      case "postElicitation":
      case "updatePlan":
      case "postError":
        linear.push(action);
        break;
      case "replyPermission":
      case "replyQuestion":
        break;
    }
  }
  return linear;
}

function extractSessionId(event: OpencodeEvent): string | null {
  if (!isRecord(event.properties)) return null;

  const sessionID = event.properties["sessionID"];
  if (typeof sessionID === "string") return sessionID;

  const part = event.properties["part"];
  if (isRecord(part)) {
    const partSessionId = part["sessionID"];
    if (typeof partSessionId === "string") return partSessionId;
  }

  return null;
}

export async function handleEvent(
  event: OpencodeEvent,
  linear: LinearService,
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const sessionId = extractSessionId(event);
  if (!sessionId) return;

  const session = await getSessionAsync(sessionId);
  if (!session?.linear.sessionId) return;

  const ctx = {
    linearSessionId: session.linear.sessionId,
    opencodeSessionId: sessionId,
    workdir: session.linear.workdir,
    issueId: session.linear.issueId,
  };

  const state = getHandlerState(sessionId);

  if (event.type === "message.part.updated") {
    if (!isRecord(event.properties)) return;
    const part = event.properties["part"];
    if (isToolPart(part)) {
      if (isQuestionTool(part.tool)) {
        const result = processQuestionFromTool(part, state, ctx);
        updateHandlerState(sessionId, result.state);
        await executeLinearActions(filterLinearActions(result.actions), linear);
        if (result.pendingQuestion) {
          await savePendingQuestion(result.pendingQuestion);
        }
        return;
      }

      const result = processToolPart(part, state, ctx);
      updateHandlerState(sessionId, result.state);
      await executeLinearActions(filterLinearActions(result.actions), linear);
      return;
    }

    if (isTextPart(part)) {
      const result = processTextPart(part, state, ctx);
      updateHandlerState(sessionId, result.state);
      await executeLinearActions(filterLinearActions(result.actions), linear);
    }

    return;
  }

  if (event.type === "message.updated") {
    if (!isRecord(event.properties)) return;
    const info = event.properties["info"];
    if (!isAssistantMessageInfo(info)) return;
    if (!info.time.completed) return;

    const result = processMessageCompleted(info.id, state, ctx);
    updateHandlerState(sessionId, result.state);
    await executeLinearActions(filterLinearActions(result.actions), linear);
    return;
  }

  if (event.type === "todo.updated") {
    const props = toTodoUpdatedProperties(event.properties);
    if (!props) return;
    const actions = processTodoUpdated(props, ctx);
    await executeLinearActions(filterLinearActions(actions), linear);
    return;
  }

  if (event.type === "permission.asked") {
    if (!isPermissionRequest(event.properties)) return;
    const result = processPermissionAsked(event.properties, ctx);
    await executeLinearActions(filterLinearActions(result.actions), linear);
    if (result.pendingPermission) {
      await savePendingPermission(result.pendingPermission);
    }
    return;
  }

  if (event.type === "question.asked") {
    if (!isQuestionRequest(event.properties)) return;
    const result = processQuestionAsked(event.properties, ctx);
    await executeLinearActions(filterLinearActions(result.actions), linear);
    if (result.pendingQuestion) {
      await savePendingQuestion(result.pendingQuestion);
    }
    return;
  }

  if (event.type === "session.error") {
    const props = toSessionErrorProperties(event.properties);
    if (!props) return;
    const result = processSessionError(props, state, ctx);
    updateHandlerState(sessionId, result.state);
    await executeLinearActions(filterLinearActions(result.actions), linear);
    return;
  }

  if (event.type === "session.idle") {
    return;
  }

  log("Unhandled event type", { type: event.type });
}
