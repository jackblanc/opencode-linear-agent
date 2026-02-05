import type { QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2";
import type {
  PendingQuestion,
  QuestionInfo,
} from "../session/SessionRepository";
import type { HandlerState } from "../session/SessionState";
import type { Action, HandlerResultWithQuestion } from "../actions/types";

/**
 * Context needed for question handler processing
 */
export interface QuestionHandlerContext {
  linearSessionId: string;
  opencodeSessionId: string;
  workdir: string | null;
  issueId: string;
}

interface QuestionResult {
  state: HandlerState;
  actions: Action[];
  pendingQuestion?: PendingQuestion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuestionTool(tool: string): boolean {
  const toolLower = tool.toLowerCase();
  return toolLower === "question" || toolLower.endsWith("_question");
}

function parseToolQuestions(args: unknown): QuestionInfo[] {
  if (!isRecord(args)) return [];

  const questionsValue = args["questions"];
  if (!Array.isArray(questionsValue)) return [];

  const questions: QuestionInfo[] = [];

  for (const entry of questionsValue) {
    if (!isRecord(entry)) continue;
    const questionValue = entry["question"];
    if (typeof questionValue !== "string" || !questionValue.trim()) continue;

    const headerValue = entry["header"];
    const header = typeof headerValue === "string" ? headerValue : "";

    const optionsValue = entry["options"];
    const options: QuestionInfo["options"] = Array.isArray(optionsValue)
      ? optionsValue
          .map((opt) => {
            if (!isRecord(opt)) return null;
            const labelValue = opt["label"];
            if (typeof labelValue !== "string") return null;
            const descriptionValue = opt["description"];
            return {
              label: labelValue,
              description:
                typeof descriptionValue === "string" ? descriptionValue : "",
            };
          })
          .filter((opt): opt is QuestionInfo["options"][number] => Boolean(opt))
      : [];

    const multipleValue = entry["multiple"];
    const multiple =
      typeof multipleValue === "boolean" ? multipleValue : undefined;

    questions.push({
      question: questionValue,
      header,
      options,
      multiple,
    });
  }

  return questions;
}

function buildQuestionAction(
  question: QuestionInfo,
  sessionId: string,
  includeDescriptions: boolean,
): Action {
  const header = question.header ? `**${question.header}**\n\n` : "";

  if (question.options.length > 0) {
    const options = question.options.map((opt) => ({ value: opt.label }));
    const optionsList = includeDescriptions
      ? question.options
          .map((opt) => `- **${opt.label}**: ${opt.description}`)
          .join("\n")
      : "";

    const body = includeDescriptions
      ? `${header}${question.question}\n\n${optionsList}`
      : `${header}${question.question}`;

    return {
      type: "postElicitation",
      sessionId,
      body,
      signal: "select",
      metadata: { options },
    };
  }

  return {
    type: "postActivity",
    sessionId,
    content: { type: "elicitation", body: `${header}${question.question}` },
    ephemeral: false,
  };
}

/**
 * Process a question.asked event - pure function
 *
 * Posts one elicitation per question with a select signal, then returns
 * the pending question data for the orchestrator to store.
 *
 * Takes event properties and returns actions + pending question.
 * No side effects, no I/O.
 */
export function processQuestionAsked(
  properties: QuestionRequest,
  ctx: QuestionHandlerContext,
): HandlerResultWithQuestion {
  const { id, sessionID, questions } = properties;

  // Only process for our session
  if (sessionID !== ctx.opencodeSessionId) {
    return { actions: [] };
  }

  // Convert OpenCode question format to our internal format
  const questionInfos: QuestionInfo[] = questions.map((q) => ({
    question: q.question,
    header: q.header,
    options: q.options.map((opt) => ({
      label: opt.label,
      description: opt.description,
    })),
    multiple: q.multiple,
  }));

  // Build actions for each question elicitation
  const actions: Action[] = questionInfos.map((q) =>
    buildQuestionAction(q, ctx.linearSessionId, true),
  );

  // Build pending question for storage
  const pendingQuestion: PendingQuestion = {
    requestId: id,
    opencodeSessionId: sessionID,
    linearSessionId: ctx.linearSessionId,
    workdir: ctx.workdir ?? "",
    issueId: ctx.issueId,
    questions: questionInfos,
    answers: questionInfos.map(() => null), // Initialize all as unanswered
    createdAt: Date.now(),
  };

  return { actions, pendingQuestion };
}

/**
 * Process a question tool part - pure function
 *
 * Handles tool-based questions (question/mcp_question) and returns
 * actions + pending question when the tool starts running.
 */
export function processQuestionFromTool(
  part: ToolPart,
  state: HandlerState,
  ctx: QuestionHandlerContext,
): QuestionResult {
  if (!isQuestionTool(part.tool)) {
    return { state, actions: [] };
  }

  if (part.state.status !== "running") {
    return { state, actions: [] };
  }

  const callId = part.callID;
  if (!callId) {
    return { state, actions: [] };
  }

  if (state.postedQuestionElicitations.has(callId)) {
    return { state, actions: [] };
  }

  const newState: HandlerState = {
    ...state,
    postedQuestionElicitations: new Set([
      ...state.postedQuestionElicitations,
      callId,
    ]),
  };

  const questionInfos = parseToolQuestions(part.state.input);
  if (questionInfos.length === 0) {
    return { state: newState, actions: [] };
  }

  const actions = questionInfos.map((q) =>
    buildQuestionAction(q, ctx.linearSessionId, false),
  );

  const pendingQuestion: PendingQuestion = {
    requestId: callId,
    opencodeSessionId: ctx.opencodeSessionId,
    linearSessionId: ctx.linearSessionId,
    workdir: ctx.workdir ?? "",
    issueId: ctx.issueId,
    questions: questionInfos,
    answers: questionInfos.map(() => null),
    createdAt: Date.now(),
  };

  return { state: newState, actions, pendingQuestion };
}
