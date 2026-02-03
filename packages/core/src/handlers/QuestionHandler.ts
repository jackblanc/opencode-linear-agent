import type { QuestionRequest } from "@opencode-ai/sdk/v2";
import type {
  PendingQuestion,
  QuestionInfo,
} from "../session/SessionRepository";
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
  const actions: Action[] = questionInfos.map((q) => {
    // Build option values from labels
    const options = q.options.map((opt) => ({ value: opt.label }));

    // Format body with question and option descriptions
    const optionsList = q.options
      .map((opt) => `- **${opt.label}**: ${opt.description}`)
      .join("\n");
    const body = `${q.question}\n\n${optionsList}`;

    return {
      type: "postElicitation" as const,
      sessionId: ctx.linearSessionId,
      body,
      signal: "select" as const,
      metadata: { options },
    };
  });

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
