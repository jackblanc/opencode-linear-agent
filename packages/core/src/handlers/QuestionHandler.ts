import type { QuestionRequest } from "@opencode-ai/sdk/v2";
import type { LinearService } from "../linear/LinearService";
import type {
  PendingQuestion,
  QuestionInfo,
} from "../session/SessionRepository";
import type { Logger } from "../logger";

/**
 * Handles question.asked events - posts elicitations to Linear.
 */
export class QuestionHandler {
  constructor(
    private readonly linear: LinearService,
    private readonly linearSessionId: string,
    private readonly opencodeSessionId: string,
    private readonly log: Logger,
    private readonly workdir: string | null = null,
  ) {}

  /**
   * Handle question.asked event - post elicitations to Linear
   *
   * Posts one elicitation per question with a select signal, then returns
   * the pending question data for the caller to store.
   */
  async handleQuestionAsked(
    properties: QuestionRequest,
  ): Promise<PendingQuestion | null> {
    const { id, sessionID, questions } = properties;

    // Only process for our session
    if (sessionID !== this.opencodeSessionId) {
      return null;
    }

    this.log.info("Question asked - posting elicitations to Linear", {
      requestId: id,
      questionCount: questions.length,
    });

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

    // Post elicitation for each question
    for (const q of questionInfos) {
      // Build option values from labels
      const options = q.options.map((opt) => ({ value: opt.label }));

      // Format body with question and option descriptions
      const optionsList = q.options
        .map((opt) => `- **${opt.label}**: ${opt.description}`)
        .join("\n");
      const body = `${q.question}\n\n${optionsList}`;

      await this.linear.postElicitation(this.linearSessionId, body, "select", {
        options,
      });
    }

    // Return pending question data for caller to store
    return {
      requestId: id,
      opcodeSessionId: sessionID,
      linearSessionId: this.linearSessionId,
      workdir: this.workdir ?? "",
      questions: questionInfos,
      answers: questionInfos.map(() => null), // Initialize all as unanswered
      createdAt: Date.now(),
    };
  }
}
