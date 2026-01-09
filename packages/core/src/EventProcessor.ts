import type { OpencodeClient, Event as OpencodeEvent } from "@opencode-ai/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { LinearAdapter } from "./linear/LinearAdapter";
import type { SessionRepository } from "./session/SessionRepository";
import type { GitOperations } from "./git/GitOperations";
import { SessionManager } from "./session/SessionManager";
import { SSEEventHandler, type SSEEventResult } from "./SSEEventHandler";
import { base64Encode } from "./utils/encode";

/**
 * Maximum number of retry attempts when commit guard blocks the agent
 */
const MAX_COMMIT_GUARD_RETRIES = 3;

/**
 * Log an OpenCode event to Worker logs for observability
 */
function logOpencodeEvent(
  event: OpencodeEvent,
  linearSessionId: string,
  opencodeSessionId: string,
): void {
  // Extract relevant properties based on event type
  const logEntry: Record<string, unknown> = {
    message: `OpenCode: ${event.type}`,
    stage: "opencode",
    eventType: event.type,
    linearSessionId,
    opencodeSessionId,
  };

  // Add event-specific properties
  if ("properties" in event && event.properties) {
    const props = event.properties as Record<string, unknown>;

    // Include common useful properties
    if (props.sessionID) {
      logEntry.eventSessionId = props.sessionID;
    }
    if (props.error) {
      logEntry.error = props.error;
    }
    if (props.status) {
      logEntry.status = props.status;
    }

    // For message events, include message info
    if (props.messageID) {
      logEntry.messageId = props.messageID;
    }
    if (props.partID) {
      logEntry.partId = props.partID;
    }

    // For file events
    if (props.path) {
      logEntry.filePath = props.path;
    }

    // For todo events
    if (props.todos && Array.isArray(props.todos)) {
      logEntry.todoCount = props.todos.length;
    }
  }

  // Use console.info for normal events, console.error for errors
  if (event.type === "session.error") {
    console.error(logEntry);
  } else {
    console.info(logEntry);
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
}

const DEFAULT_CONFIG: EventProcessorConfig = {
  providerID: "opencode",
  modelID: "minimax-m2.1-free",
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
 * It knows nothing about Cloudflare, KV, Sandbox, etc.
 */
export class EventProcessor {
  private readonly sessionManager: SessionManager;
  private readonly config: EventProcessorConfig;

  constructor(
    private readonly opencodeClient: OpencodeClient,
    private readonly linear: LinearAdapter,
    sessions: SessionRepository,
    private readonly git: GitOperations,
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
    const issueId =
      event.agentSession.issue?.id ?? event.agentSession.issueId ?? "unknown";

    console.info({
      message: "Processing event",
      stage: "processor",
      action: event.action,
      linearSessionId,
      issueId,
    });

    try {
      // Get existing state to check for branch
      const existingState =
        await this.sessionManager["repository"].get(linearSessionId);
      const existingBranch = existingState?.branchName;

      // Ensure worktree exists with progress callback
      const { workdir, branchName } = await this.git.ensureWorktree(
        linearSessionId,
        issueId,
        existingBranch,
        async (step, details) =>
          this.linear.postGitStepActivity(linearSessionId, step, details),
      );

      console.info({
        message: "Worktree ready",
        stage: "processor",
        linearSessionId,
        workdir,
        branchName,
      });

      // Post session ready stage activity with branch info
      await this.linear.postStageActivity(
        linearSessionId,
        "session_ready",
        `Branch: \`${branchName}\``,
      );

      // Get or create OpenCode session
      const sessionResult = await this.sessionManager.getOrCreateSession(
        linearSessionId,
        issueId,
        branchName,
        workdir,
      );
      const opcodeSessionId = sessionResult.opcodeSessionId;

      console.info({
        message: "OpenCode session ready",
        stage: "processor",
        linearSessionId,
        opcodeSessionId,
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
          issueId,
          workdir,
          sessionResult.previousContext,
        );
      } else if (event.action === "prompted") {
        await this.handlePrompted(
          event,
          opcodeSessionId,
          linearSessionId,
          issueId,
          workdir,
          sessionResult.previousContext,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      console.error({
        message: "Error processing event",
        stage: "processor",
        error: errorMessage,
        stack: errorStack,
        linearSessionId,
        issueId,
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
  ): Promise<SSEEventResult> {
    console.info({
      message: "Subscribing to OpenCode event stream",
      stage: "processor",
      linearSessionId,
      opencodeSessionId,
    });

    const eventStream = await this.opencodeClient.event.subscribe({
      query: { directory: workdir },
    });

    // Create the SSE event handler to process events and post to Linear
    const handler = new SSEEventHandler(
      this.linear,
      linearSessionId,
      opencodeSessionId,
      this.opencodeClient,
    );

    let finalResult: SSEEventResult = { action: "break" };

    for await (const event of eventStream.stream) {
      // Log every event for observability
      logOpencodeEvent(event, linearSessionId, opencodeSessionId);

      // Process the event via handler (posts activities to Linear, handles permissions)
      const result = await handler.handleEvent(event);

      // Break if handler signals completion (session.idle, session.error, or retry)
      if (result.action === "break" || result.action === "retry") {
        console.info({
          message:
            result.action === "retry"
              ? "Session needs retry (commit guard)"
              : "Session completed",
          stage: "processor",
          linearSessionId,
          opencodeSessionId,
        });
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
  ): Promise<SSEEventResult> {
    // Post sending prompt stage activity
    await this.linear.postStageActivity(linearSessionId, "sending_prompt");

    // Send prompt and subscribe to events concurrently
    const [, result] = await Promise.all([
      this.opencodeClient.session.prompt({
        path: { id: opcodeSessionId },
        query: { directory: workdir },
        body: {
          model: {
            providerID: this.config.providerID,
            modelID: this.config.modelID,
          },
          parts: [{ type: "text", text: prompt }],
        },
      }),
      this.subscribeAndWaitForCompletion(
        opcodeSessionId,
        linearSessionId,
        workdir,
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
  ): Promise<void> {
    // First iteration with initial prompt
    let result = await this.executePromptIteration(
      opcodeSessionId,
      linearSessionId,
      workdir,
      initialPrompt,
    );

    // If no retry needed, we're done
    if (result.action !== "retry") {
      console.info({
        message: "OpenCode session completed",
        stage: "processor",
        linearSessionId,
        opcodeSessionId,
      });
      return;
    }

    // Handle retries
    for (
      let retryCount = 1;
      retryCount <= MAX_COMMIT_GUARD_RETRIES;
      retryCount++
    ) {
      console.info({
        message: "Commit guard triggered, retrying",
        stage: "processor",
        linearSessionId,
        opcodeSessionId,
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
      );

      // If this iteration succeeded, we're done
      if (result.action !== "retry") {
        console.info({
          message: "OpenCode session completed after retry",
          stage: "processor",
          linearSessionId,
          opcodeSessionId,
          retryCount,
        });
        return;
      }
    }

    // Max retries exceeded
    console.error({
      message: "Max commit guard retries exceeded",
      stage: "processor",
      linearSessionId,
      opcodeSessionId,
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
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opcodeSessionId: string,
    linearSessionId: string,
    issueId: string,
    workdir: string,
    previousContext?: string,
  ): Promise<void> {
    const basePrompt = event.promptContext ?? "Please help with this issue.";
    // Inject previous context if we had to recreate the session
    const prompt = previousContext
      ? `${previousContext}${basePrompt}`
      : basePrompt;

    console.info({
      message: "Starting new session with prompt",
      stage: "processor",
      linearSessionId,
      opcodeSessionId,
      issueId,
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    // Send prompt with retry loop for commit guard
    await this.promptWithRetry(
      opcodeSessionId,
      linearSessionId,
      workdir,
      prompt,
    );
  }

  /**
   * Handle follow-up prompts
   */
  private async handlePrompted(
    event: AgentSessionEventWebhookPayload,
    opcodeSessionId: string,
    linearSessionId: string,
    issueId: string,
    workdir: string,
    previousContext?: string,
  ): Promise<void> {
    // Check for stop signal
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      console.info({
        message: "Stop signal received, aborting session",
        stage: "processor",
        linearSessionId,
        opcodeSessionId,
        issueId,
      });

      await this.opencodeClient.session.abort({
        path: { id: opcodeSessionId },
        query: { directory: workdir },
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

    console.info({
      message: "Sending follow-up prompt",
      stage: "processor",
      linearSessionId,
      opcodeSessionId,
      issueId,
      promptLength: prompt.length,
      hasPreviousContext: !!previousContext,
    });

    // Send prompt with retry loop for commit guard
    await this.promptWithRetry(
      opcodeSessionId,
      linearSessionId,
      workdir,
      prompt,
    );
  }
}
