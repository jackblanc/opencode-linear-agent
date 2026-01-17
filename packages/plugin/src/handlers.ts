/**
 * Event handlers for transforming OpenCode events to Linear activities.
 */

import type {
  Event,
  ToolPart,
  TextPart,
  ToolState,
  Todo,
} from "@opencode-ai/sdk";
import type { LinearService } from "./linear/client";
import type { PlanItem } from "./linear/types";
import {
  savePendingQuestion,
  savePendingPermission,
  type PendingQuestion,
  type PendingPermission,
} from "./storage";
import {
  getSession,
  markToolRunning,
  markToolCompleted,
  isTextPartSent,
  markTextPartSent,
  markFinalResponsePosted,
  markErrorPosted,
  hasErrorPosted,
} from "./state";

export type Logger = (message: string) => void;

const MAX_OUTPUT_LENGTH = 500;

const TOOL_ACTION_MAP: Record<string, { action: string; past: string }> = {
  read: { action: "Reading", past: "Read" },
  edit: { action: "Editing", past: "Edited" },
  write: { action: "Creating", past: "Created" },
  bash: { action: "Running", past: "Ran" },
  glob: { action: "Searching files", past: "Searched files" },
  grep: { action: "Searching code", past: "Searched code" },
  task: { action: "Delegating task", past: "Delegated task" },
  todowrite: { action: "Updating plan", past: "Updated plan" },
  todoread: { action: "Reading plan", past: "Read plan" },
  mcp_question: { action: "Asking question", past: "Asked question" },
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toGerund(verb: string): string {
  const lower = verb.toLowerCase();
  if (lower.endsWith("e") && !lower.endsWith("ee")) {
    return verb.slice(0, -1) + "ing";
  }
  const len = lower.length;
  if (len >= 3) {
    const last = lower.charAt(len - 1);
    const secondLast = lower.charAt(len - 2);
    const thirdLast = lower.charAt(len - 3);
    const vowels = "aeiou";
    const noDouble = "wxy";
    if (
      !vowels.includes(last) &&
      !noDouble.includes(last) &&
      vowels.includes(secondLast) &&
      !vowels.includes(thirdLast)
    ) {
      return verb + last + "ing";
    }
  }
  return verb + "ing";
}

function getToolActionName(name: string, completed: boolean): string {
  const mapping = TOOL_ACTION_MAP[name.toLowerCase()];
  if (!mapping) {
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    return completed ? capitalized : toGerund(capitalized);
  }
  return completed ? mapping.past : mapping.action;
}

function truncate(text: string): string {
  if (text.length > MAX_OUTPUT_LENGTH) {
    return text.slice(0, MAX_OUTPUT_LENGTH) + "...(truncated)";
  }
  return text;
}

function extractParameter(
  name: string,
  input: { [key: string]: unknown },
): string {
  const key = name.toLowerCase();
  switch (key) {
    case "read":
    case "edit":
    case "write": {
      const filePath = input["filePath"];
      const path = input["path"];
      if (isString(filePath)) return filePath;
      if (isString(path)) return path;
      return "file";
    }
    case "bash": {
      const command = input["command"];
      return isString(command) ? command : "command";
    }
    case "glob":
    case "grep": {
      const pattern = input["pattern"];
      return isString(pattern) ? pattern : "pattern";
    }
    case "task": {
      const description = input["description"];
      return isString(description) ? description : "task";
    }
    case "mcp_question": {
      const questions = input["questions"];
      if (Array.isArray(questions) && questions[0]) {
        const first: unknown = questions[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "question" in first
        ) {
          const question = (first as { question: unknown }).question;
          if (isString(question)) return question.slice(0, 100);
        }
      }
      return "user input";
    }
    default: {
      const firstKey = Object.keys(input)[0];
      if (firstKey) {
        const value = input[firstKey];
        if (isString(value)) return value.slice(0, 100);
      }
      return name;
    }
  }
}

function getToolThought(
  name: string,
  input: { [key: string]: unknown },
): string | null {
  const key = name.toLowerCase();
  const commandValue = input["command"];
  const command = isString(commandValue) ? commandValue : "";

  if (key === "bash" && command) {
    if (command.includes("test") || command.includes("bun run check")) {
      return "Running tests to verify changes...";
    }
    if (command.includes("gh pr create")) {
      return "Creating pull request...";
    }
    if (command.includes("git commit")) {
      return "Committing changes...";
    }
    if (command.includes("git push")) {
      return "Pushing changes to remote...";
    }
    if (command.includes("npm install") || command.includes("bun install")) {
      return "Installing dependencies...";
    }
  }

  if (key === "grep") return "Searching codebase...";
  if (key === "glob") return "Finding relevant files...";
  if (key === "task") return "Delegating subtask...";

  return null;
}

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type === "tool";
}

function isTextPart(part: { type: string }): part is TextPart {
  return part.type === "text";
}

function getStateInput(state: ToolState): { [key: string]: unknown } {
  return state.input;
}

export async function handleToolPart(
  event: Event,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  if (event.type !== "message.part.updated") return;

  const part = event.properties.part;
  if (!isToolPart(part)) return;

  const session = getSession(part.sessionID);
  if (!session || !session.linear.sessionId) return;

  const state = part.state;
  const input = getStateInput(state);

  if (state.status === "running") {
    if (!markToolRunning(part.sessionID, part.id)) return;

    const thought = getToolThought(part.tool, input);
    if (thought) {
      const result = await linear.postActivity(
        session.linear.sessionId,
        { type: "thought", body: thought },
        true,
      );
      if (result.status === "error") {
        log(`postActivity (thought) failed: ${result.error.message}`);
      }
    }

    const result = await linear.postActivity(
      session.linear.sessionId,
      {
        type: "action",
        action: getToolActionName(part.tool, false),
        parameter: extractParameter(part.tool, input),
      },
      true,
    );
    if (result.status === "error") {
      log(`postActivity (action running) failed: ${result.error.message}`);
    }
    return;
  }

  if (state.status === "completed") {
    markToolCompleted(part.sessionID, part.id);

    const result = await linear.postActivity(
      session.linear.sessionId,
      {
        type: "action",
        action: getToolActionName(part.tool, true),
        parameter: extractParameter(part.tool, input),
        result: truncate(state.output),
      },
      false,
    );
    if (result.status === "error") {
      log(`postActivity (action completed) failed: ${result.error.message}`);
    }
    return;
  }

  if (state.status === "error") {
    markToolCompleted(part.sessionID, part.id);

    const result = await linear.postActivity(
      session.linear.sessionId,
      {
        type: "action",
        action: getToolActionName(part.tool, true),
        parameter: extractParameter(part.tool, input),
        result: `Error: ${truncate(state.error)}`,
      },
      false,
    );
    if (result.status === "error") {
      log(`postActivity (action error) failed: ${result.error.message}`);
    }
  }
}

export async function handleTextPart(
  event: Event,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  if (event.type !== "message.part.updated") return;

  const part = event.properties.part;
  if (!isTextPart(part)) return;

  const session = getSession(part.sessionID);
  if (!session || !session.linear.sessionId) return;

  if (!part.time?.end) return;
  if (isTextPartSent(part.sessionID, part.id)) return;

  const text = part.text.trim();
  if (!text) return;

  markTextPartSent(part.sessionID, part.id);
  markFinalResponsePosted(part.sessionID);

  const result = await linear.postActivity(
    session.linear.sessionId,
    { type: "response", body: text },
    false,
  );
  if (result.status === "error") {
    log(`postActivity (response) failed: ${result.error.message}`);
  }
}

export async function handleTodoUpdated(
  event: Event,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  if (event.type !== "todo.updated") return;

  const { sessionID, todos } = event.properties;

  const session = getSession(sessionID);
  if (!session || !session.linear.sessionId) return;

  const plan: PlanItem[] = todos.map((todo: Todo) => ({
    content: todo.content,
    status: mapTodoStatus(todo.status),
  }));

  const result = await linear.updatePlan(session.linear.sessionId, plan);
  if (result.status === "error") {
    log(`updatePlan failed: ${result.error.message}`);
  }
}

function mapTodoStatus(
  status: string,
): "pending" | "inProgress" | "completed" | "canceled" {
  switch (status) {
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    case "cancelled":
      return "canceled";
    default:
      return "pending";
  }
}

export function handleSessionIdle(_event: Event): void {
  // No-op: final text response already posted by handleTextPart
}

export async function handleSessionError(
  event: Event,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  if (event.type !== "session.error") return;

  const { sessionID, error } = event.properties;

  if (!sessionID) return;

  const session = getSession(sessionID);
  if (!session || !session.linear.sessionId) return;

  if (hasErrorPosted(sessionID)) return;
  markErrorPosted(sessionID);

  let message = "Unknown error";
  if (error?.data && "message" in error.data && isString(error.data.message)) {
    message = error.data.message;
  } else if (error?.name) {
    message = error.name;
  }

  const result = await linear.postActivity(
    session.linear.sessionId,
    { type: "error", body: `**Error:** ${message}` },
    false,
  );
  if (result.status === "error") {
    log(`postActivity (error) failed: ${result.error.message}`);
  }
}

/**
 * Handle permission requests - post elicitation and save pending state
 */
export async function handlePermissionAsk(
  sessionId: string,
  requestId: string,
  permission: string,
  patterns: string[],
  metadata: Record<string, unknown>,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session || !session.linear.sessionId) return;

  const patternList =
    patterns.length > 0 ? `\n\nPatterns:\n- ${patterns.join("\n- ")}` : "";
  const body = `**Permission Required: ${permission}**${patternList}\n\nSelect an option:`;

  const options = [
    { value: "Approve" },
    { value: "Approve Always" },
    { value: "Reject" },
  ];

  // Post elicitation to Linear
  const result = await linear.postElicitation(
    session.linear.sessionId,
    body,
    "select",
    { options },
  );
  if (result.status === "error") {
    log(`postElicitation failed: ${result.error.message}`);
    return;
  }

  // Save pending permission to shared store
  const pending: PendingPermission = {
    requestId,
    opcodeSessionId: sessionId,
    linearSessionId: session.linear.sessionId,
    workdir: session.linear.workdir,
    issueId: session.linear.issueId,
    permission,
    patterns,
    metadata,
    createdAt: Date.now(),
  };

  await savePendingPermission(session.linear.storePath, pending);
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
}

interface McpQuestionArgs {
  questions?: Question[];
}

/**
 * Handle mcp_question tool calls - post elicitations and save pending state
 */
export async function handleQuestionElicitation(
  sessionId: string,
  requestId: string,
  args: unknown,
  linear: LinearService,
  log: Logger,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session || !session.linear.sessionId) return;

  if (!args || typeof args !== "object") return;
  const questionArgs = args as McpQuestionArgs;
  if (
    !Array.isArray(questionArgs.questions) ||
    questionArgs.questions.length === 0
  )
    return;

  const linearSessionId = session.linear.sessionId;

  // Post elicitations to Linear
  const posts = questionArgs.questions
    .filter((q) => q.question)
    .map(async (question) => {
      const header = question.header ? `**${question.header}**\n\n` : "";
      const body = `${header}${question.question}`;

      if (Array.isArray(question.options) && question.options.length > 0) {
        const options = question.options.map((opt) => ({
          value: opt.label,
          description: opt.description,
        }));

        const result = await linear.postElicitation(
          linearSessionId,
          body,
          "select",
          { options },
        );
        if (result.status === "error") {
          log(`postElicitation (question) failed: ${result.error.message}`);
        }
      } else {
        const result = await linear.postActivity(
          linearSessionId,
          { type: "elicitation", body },
          false,
        );
        if (result.status === "error") {
          log(`postActivity (question) failed: ${result.error.message}`);
        }
      }
    });

  await Promise.all(posts);

  // Save pending question to shared store
  const pending: PendingQuestion = {
    requestId,
    opcodeSessionId: sessionId,
    linearSessionId,
    workdir: session.linear.workdir,
    issueId: session.linear.issueId,
    questions: questionArgs.questions.map((q) => ({
      question: q.question,
      header: q.header ?? "",
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        description: o.description ?? "",
      })),
    })),
    answers: questionArgs.questions.map(() => null),
    createdAt: Date.now(),
  };

  await savePendingQuestion(session.linear.storePath, pending);
}
