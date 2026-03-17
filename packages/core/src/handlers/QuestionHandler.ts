import type { QuestionInfo as SdkQuestionInfo } from "@opencode-ai/sdk/v2";
import type {
  PendingQuestion,
  QuestionInfo,
} from "../session/SessionRepository";
import type { Action, HandlerResultWithQuestion } from "../actions/types";

function toUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function formatOptionLine(label: string, description: string): string {
  if (description.length === 0) {
    return `- ${label}`;
  }
  return `- ${label} - ${description}`;
}

/**
 * Context needed for question handler processing
 */
interface QuestionHandlerContext {
  linearSessionId: string;
  opencodeSessionId: string;
  workdir: string | null;
  issueId: string;
}

/**
 * Internal function that processes questions into actions and pending state.
 * Shared by processQuestionAsked.
 */
function processQuestions(
  requestId: string,
  questions: SdkQuestionInfo[],
  ctx: QuestionHandlerContext,
): HandlerResultWithQuestion {
  if (questions.length === 0) {
    return { actions: [] };
  }

  const questionInfos: QuestionInfo[] = questions
    .filter((q) => q.question)
    .map((q) => ({
      question: q.question,
      header: q.header ?? "",
      options: (q.options ?? []).map((o) => {
        const description = (o.description ?? "").trim();
        const value = description.length > 0 ? description : o.label;
        const aliases = toUnique([o.label, description, value]);
        return {
          label: o.label,
          description,
          value,
          aliases,
        };
      }),
    }));

  const actions: Action[] = questionInfos.map((q) => {
    const header = q.header ? `**${q.header}**\n\n` : "";
    const optionContext =
      q.options.length > 0
        ? `\n\nOptions:\n${q.options
            .map((opt) => formatOptionLine(opt.label, opt.description))
            .join("\n")}`
        : "";
    const body = `${header}${q.question}${optionContext}`;

    if (q.options.length > 0) {
      const options = q.options.map((opt) => ({
        label: opt.label,
        value: opt.value,
      }));
      return {
        type: "postElicitation" as const,
        sessionId: ctx.linearSessionId,
        body,
        signal: "select" as const,
        metadata: { options },
      };
    }

    return {
      type: "postActivity" as const,
      sessionId: ctx.linearSessionId,
      content: { type: "elicitation" as const, body },
      ephemeral: false,
    };
  });

  const pendingQuestion: PendingQuestion = {
    requestId,
    opencodeSessionId: ctx.opencodeSessionId,
    linearSessionId: ctx.linearSessionId,
    workdir: ctx.workdir ?? "",
    issueId: ctx.issueId,
    questions: questionInfos,
    answers: questionInfos.map(() => null),
    createdAt: Date.now(),
  };

  return { actions, pendingQuestion };
}

/**
 * Process a question.asked event - pure function
 *
 * Handles question.asked events from OpenCode by posting elicitations to Linear
 * and returning the pending question for storage.
 *
 * Uses the OpenCode question ID (from event.properties.id) as the requestId,
 * which is required for question.reply to work correctly.
 *
 * No side effects, no I/O.
 */
export function processQuestionAsked(
  questionId: string,
  questions: SdkQuestionInfo[],
  ctx: QuestionHandlerContext,
): HandlerResultWithQuestion {
  return processQuestions(questionId, questions, ctx);
}
