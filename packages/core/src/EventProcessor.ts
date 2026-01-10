import type {
  OpencodeClient,
  Event as OpencodeEvent,
} from "@opencode-ai/sdk/v2";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { LinearAdapter } from "./linear/LinearAdapter";
import type { SessionRepository } from "./session/SessionRepository";
import { SessionManager } from "./session/SessionManager";
import { SSEEventHandler, type SSEEventResult } from "./SSEEventHandler";
import { base64Encode } from "./utils/encode";
import { Log, type Logger } from "./logger";

/**
 * Maximum number of retry attempts when commit guard blocks the agent
 */
const MAX_COMMIT_GUARD_RETRIES = 3;

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

  // Use error level for session errors, info for everything else
  if (event.type === "session.error") {
    log.error(`OpenCode: ${event.type}`, extra);
  } else {
    log.info(`OpenCode: ${event.type}`, extra);
  }
}

/**
 * Configuration for the EventProcessor
 */
export interface EventProcessorConfig {
  /** Default model provider ID */
  providerID: string;
  /** Default model ID */
  modelID: string;
  /** Command to run after worktree creation (e.g., "bun install") */
  startCommand?: string;
}

const DEFAULT_CONFIG: EventProcessorConfig = {
  providerID: "opencode",
  modelID: "minimax-m2.1-free",
  startCommand: "bun install",
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
 */
export class EventProcessor {
  private readonly sessionManager: SessionManager;
  private readonly config: EventProcessorConfig;

  constructor(
    private readonly opencodeClient: OpencodeClient,
    private readonly linear: LinearAdapter,
    sessions: SessionRepository,
    private readonly repoDirectory: string,
    config?: Partial<EventProcessorConfig>,
  ) {
    this.sessionManager = new SessionManager(opencodeClient, sessions);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a Linear webhook event
   *
   * @param event - The webhook payload from Linear
   * @param workerUrl - The URL of the worker (for external links)
   */
  async process(
    event: AgentSessionEventWebhookPayload,
    workerUrl: string,
  ): Promise<void> {
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

    try {
      // Get existing state to check for existing worktree
      const existingState =
        await this.sessionManager["repository"].get(linearSessionId);

      let workdir: string;
      let branchName: string;

      if (existingState?.workdir) {
        // Reuse existing worktree
        workdir = existingState.workdir;
        branchName = existingState.branchName;

        log.info("Reusing existing worktree", { workdir, branchName });
      } else {
        // Create worktree via OpenCode native API
        await this.linear.postStageActivity(linearSessionId, "git_setup");

        log.info("Creating worktree via OpenCode", {
          repoDirectory: this.repoDirectory,
        });

        const worktreeResult = await this.opencodeClient.worktree.create({
          directory: this.repoDirectory,
          worktreeCreateInput: {
            name: issue,
            startCommand: this.config.startCommand,
          },
        });

        if (!worktreeResult.data) {
          throw new Error("Failed to create worktree: no data returned");
        }

        workdir = worktreeResult.data.directory;
        branchName = worktreeResult.data.branch;

        log.info("Worktree created", { workdir, branchName });
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
        issue,
        branchName,
        workdir,
      );
      const opcodeSessionId = sessionResult.opcodeSessionId;

      // Add OpenCode session ID to logger context
      log.tag("opcodeSession", opcodeSessionId.slice(0, 8));
      log.tag("opcodeSessionId", opcodeSessionId);

      log.info("OpenCode session ready", {
        workdir,
        isNewSession: sessionResult.isNewSession,
        hasPreviousContext: !!sessionResult.previousContext,
      });

      // Set external link to OpenCode UI
      // Format: /{base64_encoded_workdir}/session/{sessionId}
      // For local development, use localhost:4096 instead of the public webhook URL
      const opcodeBaseUrl =
        workerUrl.includes("localhost") || workerUrl.includes("127.0.0.1")
          ? "http://localhost:4096"
          : workerUrl;
      const encodedWorkdir = base64Encode(workdir);
      const externalLink = `${opcodeBaseUrl}/${encodedWorkdir}/session/${opcodeSessionId}`;
      await this.linear.setExternalLink(linearSessionId, externalLink);

      if (event.action === "created") {
        await this.handleCreated(
          event,
          opcodeSessionId,
          linearSessionId,
          issue,
          workdir,
          sessionResult.previousContext,
          log,
        );
      } else if (event.action === "prompted") {
        await this.handlePrompted(
          event,
          opcodeSessionId,
          linearSessionId,
          issue,
          workdir,
          sessionResult.previousContext,
          log,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error("Error processing event", {
        error: errorMessage,
        stack: errorStack,
      });

      // Report error to Linear
      await this.linear.postError(linearSessionId, error);

      throw error; // Re-throw for queue retry
    }
  }

  /**
   * Subscribe to OpenCode event stream, process events via SSEEventHandler,
   * and return when session completes (idle, error, or retry needed).
   *
   * @returns The final SSEEventResult indicating how the session ended
   */
  private async subscribeAndWaitForCompletion(
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    log: Logger,
  ): Promise<SSEEventResult> {
    log.info("Subscribing to OpenCode event stream");

    const eventStream = await this.opencodeClient.event.subscribe({
      directory: workdir,
    });

    // Create the SSE event handler to process events and post to Linear
    const handler = new SSEEventHandler(
      this.linear,
      linearSessionId,
      opencodeSessionId,
      this.opencodeClient,
      log.clone().tag("service", "sse-handler"),
    );

    let finalResult: SSEEventResult = { action: "break" };

    for await (const event of eventStream.stream) {
      // Log every event for observability
      logOpencodeEvent(event, log);

      // Process the event via handler (posts activities to Linear, handles permissions)
      const result = await handler.handleEvent(event);

      // Break if handler signals completion (session.idle, session.error, or retry)
      if (result.action === "break" || result.action === "retry") {
        log.info(
          result.action === "retry"
            ? "Session needs retry (commit guard)"
            : "Session completed",
        );
        finalResult = result;
        break;
      }
    }

    return finalResult;
  }

  /**
   * Execute a single prompt iteration and return the result
   */
  private async executePromptIteration(
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    prompt: string,
    log: Logger,
  ): Promise<SSEEventResult> {
    // Post sending prompt stage activity
    await this.linear.postStageActivity(linearSessionId, "sending_prompt");

    // Send prompt and subscribe to events concurrently
    const [, result] = await Promise.all([
      this.opencodeClient.session.prompt({
        sessionID: opcodeSessionId,
        directory: workdir,
        model: {
          providerID: this.config.providerID,
          modelID: this.config.modelID,
        },
        parts: [{ type: "text", text: prompt }],
      }),
      this.subscribeAndWaitForCompletion(
        opcodeSessionId,
        linearSessionId,
        workdir,
        log,
      ),
    ]);

    return result;
  }

  /**
   * Send a prompt and wait for completion, with retry loop for commit guard
   */
  private async promptWithRetry(
    opcodeSessionId: string,
    linearSessionId: string,
    workdir: string,
    initialPrompt: string,
    log: Logger,
  ): Promise<void> {
    // First iteration with initial prompt
    let result = await this.executePromptIteration(
      opcodeSessionId,
      linearSessionId,
      workdir,
      initialPrompt,
      log,
    );

    // If no retry needed, we're done
    if (result.action !== "retry") {
      log.info("OpenCode session completed");
      return;
    }

    // Handle retries
    for (
      let retryCount = 1;
      retryCount <= MAX_COMMIT_GUARD_RETRIES;
      retryCount++
    ) {
      log.info("Commit guard triggered, retrying", {
        retryCount,
        maxRetries: MAX_COMMIT_GUARD_RETRIES,
      });

      // Build retry prompt with the error context
      const retryPrompt = `${result.reason}

---

Please address the issues above. This is retry ${retryCount} of ${MAX_COMMIT_GUARD_RETRIES}.

Remember:
1. Fix any failing tests - run \`bun run check\` to verify
2. Commit all your changes with a descriptive message
3. Add any untracked files to git or .gitignore

Once everything passes, you can complete your work.`;

      result = await this.executePromptIteration(
        opcodeSessionId,
        linearSessionId,
        workdir,
        retryPrompt,
        log,
      );

      // If this iteration succeeded, we're done
      if (result.action !== "retry") {
        log.info("OpenCode session completed after retry", { retryCount });
        return;
      }
    }

    // Max retries exceeded
    log.error("Max commit guard retries exceeded", {
      retryCount: MAX_COMMIT_GUARD_RETRIES,
    });

    await this.linear.postError(
      linearSessionId,
      new Error(
        `Commit guard failed after ${MAX_COMMIT_GUARD_RETRIES} attempts. Last error:\n\n${result.reason}`,
      ),
    );
  }

  /**
   * Post initial plan to Linear
   */
  private async postInitialPlan(linearSessionId: string): Promise<void> {
    await this.linear.updatePlan(linearSessionId, [
      { content: "Understanding the issue", status: "inProgress" },
      { content: "Analyzing codebase", status: "pending" },
      { content: "Planning implementation", status: "pending" },
      { content: "Implementing changes", status: "pending" },
      { content: "Running tests", status: "pending" },
      { content: "Committing and creating PR", status: "pending" },
    ]);
  }

  /**
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opcodeSessionId: string,
    linearSessionId: string,
    issue: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    const basePrompt = event.promptContext ?? "Please help with this issue.";
    // Inject previous context if we had to recreate the session
    const prompt = previousContext
      ? `${previousContext}${basePrompt}`
      : basePrompt;

    log.info("Starting new session with prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    // Post initial plan
    await this.postInitialPlan(linearSessionId);

    // Send prompt with retry loop for commit guard
    await this.promptWithRetry(
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
    issue: string,
    workdir: string,
    previousContext: string | undefined,
    log: Logger,
  ): Promise<void> {
    // Check for stop signal
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session");

      await this.opencodeClient.session.abort({
        sessionID: opcodeSessionId,
        directory: workdir,
      });

      await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Work stopped as requested." },
        false,
      );
      return;
    }

    const basePrompt =
      event.agentActivity?.content?.body ??
      event.promptContext ??
      "Please continue.";

    // Inject previous context if we had to recreate the session (e.g., after server restart)
    const prompt = previousContext
      ? `${previousContext}${basePrompt}`
      : basePrompt;

    log.info("Sending follow-up prompt", {
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    // Send prompt with retry loop for commit guard
    await this.promptWithRetry(
      opcodeSessionId,
      linearSessionId,
      workdir,
      prompt,
      log,
    );
  }
}
