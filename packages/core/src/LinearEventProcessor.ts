import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { Result } from "better-result";
import type { LinearService } from "./linear/LinearService";
import type {
  SessionRepository,
  PendingQuestion,
  PendingPermission,
} from "./session/SessionRepository";
import { SessionManager } from "./session/SessionManager";
import { WorktreeManager } from "./session/WorktreeManager";
import { PromptBuilder } from "./session/PromptBuilder";
import { OpencodeEventProcessor } from "./OpencodeEventProcessor";
import type { OpencodeEventResult } from "./OpencodeEventProcessor";
import type { OpencodeService } from "./opencode/OpencodeService";
import { base64Encode } from "./utils/encode";
import { Log, type Logger } from "./logger";

/**
 * High-frequency events that should be DEBUG level
 */
const DEBUG_EVENTS = new Set([
  "message.part.updated",
  "message.updated",
  "session.updated",
  "session.diff",
  "session.status",
  "lsp.client.diagnostics",
]);

/**
 * Log an OpenCode event to Worker logs for observability
 */
function logOpencodeEvent(event: OpencodeEvent, log: Logger): void {
  // Extract event-specific properties
  const extra: Record<string, unknown> = { eventType: event.type };

  if ("properties" in event && event.properties) {
    const props = event.properties as Record<string, unknown>;

    if (props.error) extra.error = props.error;
    if (props.status) extra.status = props.status;
    if (props.messageID) extra.messageId = props.messageID;
    if (props.partID) extra.partId = props.partID;
    if (props.path) extra.filePath = props.path;
    if (props.todos && Array.isArray(props.todos)) {
      extra.todoCount = props.todos.length;
    }
  }

  // Use appropriate log level based on event type
  if (event.type === "session.error") {
    log.error(`OpenCode: ${event.type}`, extra);
  } else if (DEBUG_EVENTS.has(event.type)) {
    log.debug(`OpenCode: ${event.type}`, extra);
  } else {
    log.info(`OpenCode: ${event.type}`, extra);
  }
}

/**
 * Configuration for the LinearEventProcessor
 */
export interface LinearEventProcessorConfig {
  /** Command to run after worktree creation (e.g., "bun install") */
  startCommand?: string;
  /** OpenCode server URL for external links (should be localhost for security) */
  opencodeUrl?: string;
}

const DEFAULT_CONFIG: LinearEventProcessorConfig = {
  startCommand: "bun install --ignore-scripts",
  opencodeUrl: "http://localhost:4096",
};

/**
 * Check if activity has stop signal
 */
function hasStopSignal(activity: { signal?: string | null }): boolean {
  return activity.signal === "stop";
}

/**
 * Main entry point for processing Linear webhook events.
 *
 * This class is platform-agnostic and receives all dependencies via constructor injection.
 * Uses OpenCode's native worktree management instead of custom git operations.
 *
 * Delegates to specialized managers:
 * - WorktreeManager: Worktree creation/reuse logic
 * - SessionManager: OpenCode session lifecycle
 * - PromptBuilder: Context injection and prompt construction
 */
export class LinearEventProcessor {
  private readonly sessionManager: SessionManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly promptBuilder: PromptBuilder;
  private readonly config: LinearEventProcessorConfig;

  constructor(
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
    private readonly sessions: SessionRepository,
    private readonly repoDirectory: string,
    config?: Partial<LinearEventProcessorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionManager = new SessionManager(opencode, sessions);
    this.worktreeManager = new WorktreeManager(
      opencode,
      linear,
      sessions,
      repoDirectory,
      this.config.startCommand,
    );
    this.promptBuilder = new PromptBuilder();
  }

  /**
   * Process a Linear webhook event
   *
   * @param event - The webhook payload from Linear
   */
  async process(event: AgentSessionEventWebhookPayload): Promise<void> {
    const linearSessionId = event.agentSession.id;
    // Use identifier (e.g., "CODE-29") instead of id (UUID)
    const issue =
      event.agentSession.issue?.identifier ??
      event.agentSession.issueId ??
      "unknown";

    // Create a tagged logger for this processing context
    const log = Log.create({ service: "processor" })
      .tag("issue", issue)
      .tag("sessionId", linearSessionId);

    log.info("Processing event", { action: event.action });

    // Resolve or create worktree
    const worktreeResult = await this.worktreeManager.resolveWorktree(
      linearSessionId,
      issue,
      log,
    );

    if (Result.isError(worktreeResult)) {
      await this.linear.postError(linearSessionId, worktreeResult.error);
      return;
    }

    const { workdir, branchName } = worktreeResult.value;

    // Post session ready stage activity with branch info
    await this.linear.postStageActivity(
      linearSessionId,
      "session_ready",
      `Branch: \`${branchName}\``,
    );

    // Get or create OpenCode session
    const sessionResult = await this.sessionManager.getOrCreateSession(
      linearSessionId,
      issue,
      branchName,
      workdir,
    );

    if (Result.isError(sessionResult)) {
      log.error("Error getting/creating session", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });
      await this.linear.postError(linearSessionId, sessionResult.error);
      return;
    }

    const session = sessionResult.value;
    const opcodeSessionId = session.opcodeSessionId;

    // Add OpenCode session ID to logger context
    log.tag("opcodeSession", opcodeSessionId.slice(0, 8));
    log.tag("opcodeSessionId", opcodeSessionId);

    log.info("OpenCode session ready", {
      workdir,
      isNewSession: session.isNewSession,
      hasPreviousContext: !!session.previousContext,
    });

    // Set external link to OpenCode UI
    // Format: /{base64_encoded_workdir}/session/{sessionId}
    // Use configured OpenCode URL (should be localhost for security)
    const opcodeBaseUrl = this.config.opencodeUrl ?? "http://localhost:4096";
    const encodedWorkdir = base64Encode(workdir);
    const externalLink = `${opcodeBaseUrl}/${encodedWorkdir}/session/${opcodeSessionId}`;
    await this.linear.setExternalLink(linearSessionId, externalLink);

    if (event.action === "created") {
      await this.handleCreated(
        event,
        opcodeSessionId,
        linearSessionId,
        workdir,
        session.previousContext,
        log,
      );
    } else if (event.action === "prompted") {
      await this.handlePrompted(
        event,
        opcodeSessionId,
        linearSessionId,
        workdir,
        session.previousContext,
        log,
      );
    }
  }

  /**
   * Subscribe to OpenCode event stream, process events via OpencodeEventProcessor,
   * and return when session completes (idle, error, question asked, or retry needed).
   *
   * @returns The final OpencodeEventResult indicating how the session ended
   */
  private async subscribeAndWaitForCompletion(
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    log: Logger,
  ): Promise<OpencodeEventResult> {
    log.info("Subscribing to OpenCode event stream");

    const eventStream = await this.opencode.subscribe(workdir);

    // Create the OpenCode event processor to handle events and post to Linear
    const handler = new OpencodeEventProcessor(
      this.linear,
      linearSessionId,
      opencodeSessionId,
      this.opencode,
      log.clone().tag("service", "opencode-processor"),
      workdir,
    );

    for await (const event of eventStream.stream) {
      // Log every event for observability
      logOpencodeEvent(event, log);

      // Process the event via handler (posts activities to Linear, handles permissions)
      const result = await handler.handleEvent(event);

      // Break if handler signals completion (session.idle, session.error, or question asked)
      if (result.action === "break") {
        log.info("Session completed");
        return result;
      }

      if (result.action === "question_asked") {
        log.info(
          "Question asked - saving pending question and waiting for user response",
          {
            requestId: result.pendingQuestion.requestId,
            questionCount: result.pendingQuestion.questions.length,
          },
        );
        return result;
      }

      if (result.action === "permission_asked") {
        log.info(
          "Permission asked - saving pending permission and waiting for user response",
          {
            requestId: result.pendingPermission.requestId,
            permission: result.pendingPermission.permission,
          },
        );
        return result;
      }
    }

    // Stream ended without explicit break - treat as break
    return { action: "break" };
  }

  /**
   * Execute a prompt and wait for completion
   *
   * If a question is asked during execution, saves the pending question
   * and returns. The question will be handled when the user responds via
   * a prompted webhook.
   */
  private async executePrompt(
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    prompt: string,
    log: Logger,
  ): Promise<void> {
    // Post sending prompt stage activity
    await this.linear.postStageActivity(linearSessionId, "sending_prompt");

    // Fire-and-forget the prompt - don't await it
    // The prompt call may not return until session is idle, but we need to
    // handle question.asked events before that happens
    this.opencode
      .prompt(opcodeSessionId, workdir, [{ type: "text", text: prompt }])
      .then((result) => {
        if (Result.isError(result)) {
          log.error("Prompt failed", {
            error: result.error.message,
            errorType: result.error._tag,
          });
        }
      })
      .catch((error: unknown) => {
        log.error("Prompt threw exception", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    // Subscribe and wait for completion (or question asked)
    const result = await this.subscribeAndWaitForCompletion(
      opcodeSessionId,
      linearSessionId,
      workdir,
      log,
    );

    log.info("subscribeAndWaitForCompletion returned", {
      action: result.action,
    });

    // Handle question_asked - save pending question for later response
    if (result.action === "question_asked") {
      log.info("Saving pending question", {
        requestId: result.pendingQuestion.requestId,
        linearSessionId: result.pendingQuestion.linearSessionId,
      });
      await this.sessions.savePendingQuestion(result.pendingQuestion);
      log.info("Pending question saved");
      return;
    }

    // Handle permission_asked - save pending permission for later response
    if (result.action === "permission_asked") {
      log.info("Saving pending permission", {
        requestId: result.pendingPermission.requestId,
        linearSessionId: result.pendingPermission.linearSessionId,
      });
      await this.sessions.savePendingPermission(result.pendingPermission);
      log.info("Pending permission saved");
      return;
    }

    log.info("OpenCode session completed");
  }

  /**
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session");

      const abortResult = await this.opencode.abortSession(
        opcodeSessionId,
        workdir,
      );

      if (Result.isError(abortResult)) {
        log.warn("Failed to abort session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Work stopped as requested." },
        false,
      );
      return;
    }

    // Build prompt with system instructions + issue context + previous context
    const prompt = this.promptBuilder.buildCreatedPrompt(
      event,
      previousContext,
    );

    log.info("Starting new session with prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    // Send prompt and wait for completion
    await this.executePrompt(
      opcodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      log,
    );
  }

  /**
   * Handle follow-up prompts
   */
  private async handlePrompted(
    event: AgentSessionEventWebhookPayload,
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    // Check for stop signal
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session");

      const abortResult = await this.opencode.abortSession(
        opcodeSessionId,
        workdir,
      );

      if (Result.isError(abortResult)) {
        log.warn("Failed to abort session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Work stopped as requested." },
        false,
      );
      return;
    }

    const userResponse =
      event.agentActivity?.content?.body ??
      event.promptContext ??
      "Please continue.";

    // Check if there's a pending permission for this session
    const pendingPermission =
      await this.sessions.getPendingPermission(linearSessionId);

    if (pendingPermission) {
      await this.handlePermissionResponse(
        pendingPermission,
        userResponse,
        opcodeSessionId,
        linearSessionId,
        workdir,
        previousContext,
        log,
      );
      return;
    }

    // Check if there's a pending question for this session
    const pendingQuestion =
      await this.sessions.getPendingQuestion(linearSessionId);

    if (pendingQuestion) {
      await this.handleQuestionResponse(
        pendingQuestion,
        userResponse,
        opcodeSessionId,
        linearSessionId,
        workdir,
        previousContext,
        log,
      );
      return;
    }

    // No pending question or permission - treat as a normal follow-up prompt
    const prompt = this.promptBuilder.buildFollowUpPrompt(
      event,
      userResponse,
      previousContext,
    );

    log.info("Sending follow-up prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    // Send prompt and wait for completion
    await this.executePrompt(
      opcodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      log,
    );
  }

  /**
   * Handle a user response to a pending question
   *
   * The user can either:
   * 1. Select an option from the elicitation - we forward it to OpenCode
   * 2. Send a different message - we clear the pending question and send it as a prompt
   *
   * For multi-question scenarios, we collect all answers before replying.
   */
  private async handleQuestionResponse(
    pending: PendingQuestion,
    userResponse: string,
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    log.info("Received response while question pending", {
      requestId: pending.requestId,
      responseLength: userResponse.length,
      questionCount: pending.questions.length,
      answeredCount: pending.answers.filter((a) => a !== null).length,
    });

    // Find the first unanswered question
    const answerIndex = pending.answers.findIndex((a) => a === null);

    if (answerIndex === -1) {
      // All questions already answered - this shouldn't happen, but handle gracefully
      log.warn(
        "All questions already answered - clearing pending and treating as follow-up",
      );
      await this.sessions.deletePendingQuestion(linearSessionId);
      await this.sendFollowUpPrompt(
        userResponse,
        opcodeSessionId,
        linearSessionId,
        workdir,
        previousContext,
        log,
      );
      return;
    }

    // Try to match user response to an option label
    const currentQuestion = pending.questions[answerIndex];
    const matchedLabel = this.matchOptionLabel(
      userResponse,
      currentQuestion.options,
    );

    if (!matchedLabel) {
      // User response doesn't match any option - they're ignoring the question
      // Clear pending question and send as a regular follow-up prompt
      log.info(
        "User response doesn't match any option - treating as new prompt",
        {
          response: userResponse.slice(0, 100),
          availableOptions: currentQuestion.options.map((o) => o.label),
        },
      );
      await this.sessions.deletePendingQuestion(linearSessionId);
      await this.sendFollowUpPrompt(
        userResponse,
        opcodeSessionId,
        linearSessionId,
        workdir,
        previousContext,
        log,
      );
      return;
    }

    // Store the matched label as the answer
    pending.answers[answerIndex] = [matchedLabel];

    log.info("Matched user response to option", {
      userResponse: userResponse.slice(0, 50),
      matchedLabel,
    });

    // Check if all questions are now answered
    const allAnswered = pending.answers.every((a) => a !== null);

    if (!allAnswered) {
      // More questions to answer - save updated pending question and wait
      await this.sessions.savePendingQuestion(pending);
      log.info("Waiting for more question responses", {
        answered: pending.answers.filter((a) => a !== null).length,
        total: pending.questions.length,
      });
      return;
    }

    // All questions answered - reply to OpenCode
    log.info("All questions answered - replying to OpenCode", {
      answerCount: pending.answers.length,
    });

    // Filter out nulls (we just verified all are non-null above)
    const answers = pending.answers.filter((a): a is string[] => a !== null);

    const replyResult = await this.opencode.replyQuestion(
      pending.requestId,
      answers,
      workdir,
    );

    // Clean up pending question regardless of result
    await this.sessions.deletePendingQuestion(linearSessionId);

    if (Result.isError(replyResult)) {
      log.error("Failed to reply to question", {
        error: replyResult.error.message,
        errorType: replyResult.error._tag,
      });
      await this.linear.postError(linearSessionId, replyResult.error);
      return;
    }

    // Subscribe and wait for OpenCode to continue processing
    log.info("Question answered - waiting for OpenCode to continue");

    const result = await this.subscribeAndWaitForCompletion(
      opcodeSessionId,
      linearSessionId,
      workdir,
      log,
    );

    // Handle if another question was asked
    if (result.action === "question_asked") {
      log.info("Another question asked", {
        requestId: result.pendingQuestion.requestId,
      });
      await this.sessions.savePendingQuestion(result.pendingQuestion);
    }

    // Handle if a permission was asked
    if (result.action === "permission_asked") {
      log.info("Permission asked after question answered", {
        requestId: result.pendingPermission.requestId,
      });
      await this.sessions.savePendingPermission(result.pendingPermission);
    }
  }

  /**
   * Handle a user response to a pending permission request
   *
   * The user can either:
   * 1. Select "Approve" - approve once
   * 2. Select "Approve Always" - approve for all future requests of this type
   * 3. Select "Reject" - reject the permission
   * 4. Send a different message - treat as a new prompt and reject the permission
   */
  private async handlePermissionResponse(
    pending: PendingPermission,
    userResponse: string,
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    log.info("Received response while permission pending", {
      requestId: pending.requestId,
      responseLength: userResponse.length,
      permission: pending.permission,
    });

    // Map user responses to permission reply types
    const permissionOptions = ["Approve", "Approve Always", "Reject"];
    const matchedOption = this.matchPermissionOption(
      userResponse,
      permissionOptions,
    );

    if (!matchedOption) {
      // User response doesn't match any option - they're ignoring the permission
      // Reject the permission and send as a regular follow-up prompt
      log.info(
        "User response doesn't match any permission option - rejecting and treating as new prompt",
        {
          response: userResponse.slice(0, 100),
        },
      );

      await this.opencode.replyPermission(pending.requestId, "reject", workdir);
      await this.sessions.deletePendingPermission(linearSessionId);
      await this.sendFollowUpPrompt(
        userResponse,
        opcodeSessionId,
        linearSessionId,
        workdir,
        previousContext,
        log,
      );
      return;
    }

    // Map the option to the OpenCode reply type
    let reply: "once" | "always" | "reject";
    if (matchedOption === "Approve") {
      reply = "once";
    } else if (matchedOption === "Approve Always") {
      reply = "always";
    } else {
      reply = "reject";
    }

    log.info("Matched user response to permission option", {
      userResponse: userResponse.slice(0, 50),
      matchedOption,
      reply,
    });

    // Reply to the permission request
    const replyResult = await this.opencode.replyPermission(
      pending.requestId,
      reply,
      workdir,
    );

    // Clean up pending permission regardless of result
    await this.sessions.deletePendingPermission(linearSessionId);

    if (Result.isError(replyResult)) {
      log.error("Failed to reply to permission", {
        error: replyResult.error.message,
        errorType: replyResult.error._tag,
      });
      await this.linear.postError(linearSessionId, replyResult.error);
      return;
    }

    // Subscribe and wait for OpenCode to continue processing
    log.info("Permission responded - waiting for OpenCode to continue", {
      reply,
    });

    const result = await this.subscribeAndWaitForCompletion(
      opcodeSessionId,
      linearSessionId,
      workdir,
      log,
    );

    // Handle if a question was asked
    if (result.action === "question_asked") {
      log.info("Question asked after permission responded", {
        requestId: result.pendingQuestion.requestId,
      });
      await this.sessions.savePendingQuestion(result.pendingQuestion);
    }

    // Handle if another permission was asked
    if (result.action === "permission_asked") {
      log.info("Another permission asked", {
        requestId: result.pendingPermission.requestId,
      });
      await this.sessions.savePendingPermission(result.pendingPermission);
    }
  }

  /**
   * Try to match user response to a permission option
   *
   * Returns the matched option if found, null otherwise.
   */
  private matchPermissionOption(
    userResponse: string,
    options: string[],
  ): string | null {
    const normalized = userResponse.trim().toLowerCase();

    // First try exact match (case-insensitive)
    for (const opt of options) {
      if (opt.toLowerCase() === normalized) {
        return opt;
      }
    }

    // Then try if response starts with option
    for (const opt of options) {
      if (normalized.startsWith(opt.toLowerCase())) {
        return opt;
      }
    }

    // Finally try if response contains option as a whole word
    for (const opt of options) {
      const optLower = opt.toLowerCase();
      const regex = new RegExp(`\\b${this.escapeRegex(optLower)}\\b`, "i");
      if (regex.test(userResponse)) {
        return opt;
      }
    }

    return null;
  }

  /**
   * Try to match user response to an option label
   *
   * Returns the matched label if found, null otherwise.
   * Uses case-insensitive matching and also checks if response
   * contains the label (for partial matches).
   */
  private matchOptionLabel(
    userResponse: string,
    options: Array<{ label: string; description: string }>,
  ): string | null {
    const normalized = userResponse.trim().toLowerCase();

    // First try exact match (case-insensitive)
    for (const opt of options) {
      if (opt.label.toLowerCase() === normalized) {
        return opt.label;
      }
    }

    // Then try if response starts with option label
    for (const opt of options) {
      if (normalized.startsWith(opt.label.toLowerCase())) {
        return opt.label;
      }
    }

    // Finally try if response contains option label as a whole word
    for (const opt of options) {
      const labelLower = opt.label.toLowerCase();
      // Check if label appears as a word boundary match
      const regex = new RegExp(`\\b${this.escapeRegex(labelLower)}\\b`, "i");
      if (regex.test(userResponse)) {
        return opt.label;
      }
    }

    return null;
  }

  /**
   * Escape special regex characters in a string
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Send a follow-up prompt (used when user ignores pending question)
   */
  private async sendFollowUpPrompt(
    userResponse: string,
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    const prompt = this.promptBuilder.buildFollowUpWithoutEvent(
      userResponse,
      previousContext,
    );

    log.info("Sending follow-up prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    await this.executePrompt(
      opcodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      log,
    );
  }
}
