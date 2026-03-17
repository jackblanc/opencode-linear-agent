import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { Result } from "better-result";
import type { LinearService } from "./linear/LinearService";
import type {
  SessionRepository,
  PendingQuestion,
  PendingPermission,
  QuestionOption,
} from "./session/SessionRepository";
import { SessionManager } from "./session/SessionManager";
import {
  WorktreeManager,
  type SessionWorktreeAction,
  type WorktreeIssue,
} from "./session/WorktreeManager";
import { PromptBuilder, type PromptContext } from "./session/PromptBuilder";
import { type AgentMode, determineAgentMode } from "./session/AgentMode";
import type { OpencodeService } from "./opencode/OpencodeService";
import { base64Encode } from "./utils/encode";
import { Log, type Logger } from "./logger";

/**
 * Configuration for the LinearEventProcessor
 */
interface LinearEventProcessorConfig {
  /** OpenCode server URL for external links (should be localhost for security) */
  opencodeUrl?: string;
  /** Linear organization ID for OAuth token lookup */
  organizationId: string;
}

const DEFAULT_CONFIG: Omit<LinearEventProcessorConfig, "organizationId"> = {
  opencodeUrl: "http://localhost:4096",
};

/**
 * Check if activity has stop signal
 */
function hasStopSignal(activity: { signal?: string | null }): boolean {
  return activity.signal === "stop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value[field];
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? candidate : null;
}

function readPromptContextText(promptContext: unknown): string | null {
  if (typeof promptContext === "string") {
    const trimmed = promptContext.trim();
    return trimmed.length > 0 ? promptContext : null;
  }

  const body = readStringField(promptContext, "body");
  if (body) {
    return body;
  }

  if (isRecord(promptContext)) {
    const contentBody = readStringField(promptContext.content, "body");
    if (contentBody) {
      return contentBody;
    }
  }

  return null;
}

function extractPromptedUserResponse(event: {
  agentActivity?: unknown;
  promptContext?: unknown;
}): string {
  const agentBody = readStringField(event.agentActivity, "body");
  if (agentBody) {
    return agentBody;
  }

  if (isRecord(event.agentActivity)) {
    const contentBody = readStringField(event.agentActivity.content, "body");
    if (contentBody) {
      return contentBody;
    }
  }

  const promptContextBody = readPromptContextText(event.promptContext);
  if (promptContextBody) {
    return promptContextBody;
  }

  return "Please continue.";
}

function normalizeMatchInput(value: string): string {
  return value.trim().toLowerCase();
}

function hasWordBoundaryMatch(haystack: string, needle: string): boolean {
  const regex = new RegExp(`\\b${escapeRegex(needle)}\\b`, "i");
  return regex.test(haystack);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchQuestionOptionLabel(
  userResponse: string,
  options: QuestionOption[],
): string | null {
  const normalizedResponse = normalizeMatchInput(userResponse);
  if (normalizedResponse.length === 0) {
    return null;
  }

  for (const opt of options) {
    if (normalizeMatchInput(opt.label) === normalizedResponse) {
      return opt.label;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      if (normalizeMatchInput(alias) === normalizedResponse) {
        return opt.label;
      }
    }
  }

  for (const opt of options) {
    if (normalizedResponse.startsWith(normalizeMatchInput(opt.label))) {
      return opt.label;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      const normalizedAlias = normalizeMatchInput(alias);
      if (normalizedResponse.startsWith(normalizedAlias)) {
        return opt.label;
      }
    }
  }

  for (const opt of options) {
    if (hasWordBoundaryMatch(userResponse, normalizeMatchInput(opt.label))) {
      return opt.label;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      const normalizedAlias = normalizeMatchInput(alias);
      if (hasWordBoundaryMatch(userResponse, normalizedAlias)) {
        return opt.label;
      }
    }
  }

  return null;
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
    config: LinearEventProcessorConfig,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as LinearEventProcessorConfig;
    this.sessionManager = new SessionManager(opencode, sessions);
    this.worktreeManager = new WorktreeManager(
      opencode,
      linear,
      sessions,
      repoDirectory,
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
    const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
    const fallbackIssueIdentifier =
      event.agentSession.issue?.identifier ?? issueId ?? "unknown";
    let issue: WorktreeIssue = {
      identifier: fallbackIssueIdentifier,
      branchName:
        readStringField(event.agentSession.issue, "branchName") ?? undefined,
    };

    if (issueId && !issue.branchName) {
      const issueResult = await this.linear.getIssue(issueId);
      if (Result.isOk(issueResult)) {
        issue = {
          identifier: issueResult.value.identifier,
          branchName: issueResult.value.branchName,
        };
      }
    }

    // Create a tagged logger for this processing context
    const log = Log.create({ service: "processor" })
      .tag("issue", issue.identifier)
      .tag("sessionId", linearSessionId);

    log.info("Processing event", { action: event.action });

    const action = this.toSessionWorktreeAction(event.action);
    if (!action) {
      log.info("Ignoring unsupported agent session action", {
        action: event.action,
      });
      return;
    }

    // Resolve or create worktree
    const worktreeResult = await this.worktreeManager.resolveWorktree(
      linearSessionId,
      issue,
      action,
      log,
    );

    if (Result.isError(worktreeResult)) {
      await this.linear.postError(linearSessionId, worktreeResult.error);
      return;
    }

    const { workdir, branchName } = worktreeResult.value;

    // Determine agent mode based on issue state
    let mode: AgentMode = "build";

    if (issueId) {
      const stateResult = await this.linear.getIssueState(issueId);
      if (Result.isOk(stateResult)) {
        mode = determineAgentMode(stateResult.value.type);
        log.info("Determined agent mode", {
          mode,
          stateType: stateResult.value.type,
          stateName: stateResult.value.name,
        });
      } else {
        log.warn("Failed to get issue state, defaulting to build mode", {
          error: stateResult.error.message,
          errorType: stateResult.error._tag,
        });
      }

      // Only move to In Progress in build mode
      if (mode === "build") {
        const statusResult = await this.linear.moveIssueToInProgress(issueId);
        if (Result.isError(statusResult)) {
          log.warn("Failed to move issue to In Progress", {
            error: statusResult.error.message,
            errorType: statusResult.error._tag,
          });
        }
      }
    }

    // Post session ready stage activity with branch info
    await this.linear.postStageActivity(
      linearSessionId,
      "session_ready",
      `Branch: \`${branchName}\``,
    );

    // Get or create OpenCode session
    const sessionResult = await this.sessionManager.getOrCreateSession(
      linearSessionId,
      issueId ?? "unknown",
      this.repoDirectory,
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
    const opencodeSessionId = session.opencodeSessionId;

    // Add OpenCode session ID to logger context
    const sessionLog = log
      .tag("opencodeSession", opencodeSessionId.slice(0, 8))
      .tag("opencodeSessionId", opencodeSessionId);

    sessionLog.info("OpenCode session ready", {
      workdir,
      isNewSession: session.isNewSession,
      hasPreviousContext: !!session.previousContext,
    });

    // Set external link to OpenCode UI
    // Format: /{base64_encoded_workdir}/session/{sessionId}
    // Use configured OpenCode URL (should be localhost for security)
    const opencodeBaseUrl = this.config.opencodeUrl ?? "http://localhost:4096";
    const encodedWorkdir = base64Encode(workdir);
    const externalLink = `${opencodeBaseUrl}/${encodedWorkdir}/session/${opencodeSessionId}`;
    await this.linear.setExternalLink(linearSessionId, externalLink);

    switch (action) {
      case "created":
        await this.handleCreated(
          event,
          opencodeSessionId,
          linearSessionId,
          workdir,
          mode,
          session.previousContext,
          sessionLog,
        );
        return;
      case "prompted":
        await this.handlePrompted(
          event,
          opencodeSessionId,
          linearSessionId,
          workdir,
          mode,
          session.previousContext,
          sessionLog,
        );
        return;
    }
  }

  private toSessionWorktreeAction(value: string): SessionWorktreeAction | null {
    switch (value) {
      case "created":
      case "prompted":
        return value;
      default:
        return null;
    }
  }

  /**
   * Execute a prompt (fire-and-forget)
   *
   * The plugin handles all event streaming to Linear.
   * Questions and permissions are handled by the plugin, which saves
   * them to the shared store. Responses are handled when the user
   * responds via a prompted webhook.
   */
  private async executePrompt(
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    prompt: string,
    agent: AgentMode,
    log: Logger,
  ): Promise<void> {
    // Post sending prompt stage activity
    await this.linear.postStageActivity(linearSessionId, "sending_prompt");

    // Fire-and-forget the prompt with the specified agent mode
    // The plugin handles event streaming to Linear
    const result = await this.opencode.prompt(
      opencodeSessionId,
      workdir,
      [{ type: "text", text: prompt }],
      agent,
    );

    if (Result.isError(result)) {
      log.error("Prompt failed", {
        error: result.error.message,
        errorType: result.error._tag,
      });
      await this.linear.postError(linearSessionId, result.error);
      return;
    }

    log.info("Prompt sent, plugin will handle events", { agent });
  }

  /**
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    mode: AgentMode,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session silently");

      const abortResult = await this.opencode.abortSession(
        opencodeSessionId,
        workdir,
      );

      if (Result.isError(abortResult)) {
        log.warn("Failed to abort session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      // Post response to confirm stop - required by Linear agent protocol
      await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Stopped." },
        false,
      );
      return;
    }

    // Build prompt context for plugin integration
    const promptCtx: PromptContext = {
      linearSessionId,
      organizationId: this.config.organizationId,
      workdir,
    };

    // Build prompt with frontmatter + mode-specific instructions + issue context + previous context
    const prompt = this.promptBuilder.buildCreatedPrompt(
      event,
      promptCtx,
      mode,
      previousContext,
    );

    log.info("Starting new session with prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
      mode,
    });

    // Send prompt (fire-and-forget - plugin handles events)
    await this.executePrompt(
      opencodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      mode,
      log,
    );
  }

  /**
   * Handle follow-up prompts
   */
  private async handlePrompted(
    event: AgentSessionEventWebhookPayload,
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    mode: AgentMode,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    // Check for stop signal
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session silently");

      const abortResult = await this.opencode.abortSession(
        opencodeSessionId,
        workdir,
      );

      if (Result.isError(abortResult)) {
        log.warn("Failed to abort session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      // Post response to confirm stop - required by Linear agent protocol
      await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Stopped." },
        false,
      );
      return;
    }

    const userResponse = extractPromptedUserResponse(event);

    // Check if there's a pending permission for this session
    const pendingPermission =
      await this.sessions.getPendingPermission(linearSessionId);

    if (pendingPermission) {
      await this.handlePermissionResponse(
        pendingPermission,
        userResponse,
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        previousContext,
        log,
      );
      return;
    }

    // Check if there's a pending question for this session
    const pendingQuestion =
      await this.sessions.getPendingQuestion(linearSessionId);

    log.info("Checking for pending question", {
      hasPendingQuestion: !!pendingQuestion,
      pendingRequestId: pendingQuestion?.requestId,
    });

    if (pendingQuestion) {
      await this.handleQuestionResponse(
        pendingQuestion,
        userResponse,
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        previousContext,
        log,
      );
      return;
    }

    // Build prompt context for plugin integration
    const promptCtx: PromptContext = {
      linearSessionId,
      organizationId: this.config.organizationId,
      workdir,
    };

    // No pending question or permission - treat as a normal follow-up prompt
    const prompt = this.promptBuilder.buildFollowUpPrompt(
      event,
      userResponse,
      promptCtx,
      mode,
      previousContext,
    );

    log.info("Sending follow-up prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
      mode,
    });

    // Send prompt (fire-and-forget - plugin handles events)
    await this.executePrompt(
      opencodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      mode,
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
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    mode: AgentMode,
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
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        previousContext,
        log,
        pending.issueId,
      );
      return;
    }

    // Try to match user response to an option label
    const currentQuestion = pending.questions[answerIndex];
    if (!currentQuestion) {
      log.warn("No current question found at index", { answerIndex });
      await this.sessions.deletePendingQuestion(linearSessionId);
      return;
    }

    const matchedLabel = matchQuestionOptionLabel(
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
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        previousContext,
        log,
        pending.issueId,
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

    // Reply sent - plugin handles subsequent events
    log.info("Question reply sent, plugin will handle events");
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
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    mode: AgentMode,
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
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        previousContext,
        log,
        pending.issueId,
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

    // Reply sent - plugin handles subsequent events
    log.info("Permission reply sent, plugin will handle events", { reply });
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
   * Escape special regex characters in a string
   */
  private escapeRegex(str: string): string {
    return escapeRegex(str);
  }

  /**
   * Send a follow-up prompt (used when user ignores pending question)
   */
  private async sendFollowUpPrompt(
    userResponse: string,
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    mode: AgentMode,
    previousContext: string | undefined,
    log: Logger,
    issueId = "unknown",
  ): Promise<void> {
    const promptCtx: PromptContext = {
      linearSessionId,
      organizationId: this.config.organizationId,
      workdir,
    };

    const prompt = this.promptBuilder.buildFollowUpWithoutEvent(
      userResponse,
      issueId,
      promptCtx,
      mode,
      previousContext,
    );

    log.info("Sending follow-up prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
      mode,
    });

    // Send prompt (fire-and-forget - plugin handles events)
    await this.executePrompt(
      opencodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      mode,
      log,
    );
  }
}
