import type { OpencodeClient, Event as OpencodeEvent } from "@opencode-ai/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { LinearAdapter } from "./linear/LinearAdapter";
import type { SessionRepository } from "./session/SessionRepository";
import type { GitOperations } from "./git/GitOperations";
import { SessionManager } from "./session/SessionManager";
import { SSEEventHandler } from "./SSEEventHandler";
import { base64Encode } from "./utils/encode";

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
  providerID: "anthropic",
  modelID: "claude-sonnet-4-20250514",
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
      const { opencodeSessionId } =
        await this.sessionManager.getOrCreateSession(
          linearSessionId,
          issueId,
          branchName,
          workdir,
        );

      console.info({
        message: "OpenCode session ready",
        stage: "processor",
        linearSessionId,
        opencodeSessionId,
        workdir,
      });

      // Set external link to OpenCode UI
      // Format: /{base64_encoded_workdir}/session/{sessionId}
      const encodedWorkdir = base64Encode(workdir);
      const externalLink = `${workerUrl}/${encodedWorkdir}/session/${opencodeSessionId}`;
      await this.linear.setExternalLink(linearSessionId, externalLink);

      if (event.action === "created") {
        await this.handleCreated(
          event,
          opencodeSessionId,
          linearSessionId,
          issueId,
          workdir,
        );
      } else if (event.action === "prompted") {
        await this.handlePrompted(
          event,
          opencodeSessionId,
          linearSessionId,
          issueId,
          workdir,
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
   * and return when session completes (idle or error).
   */
  private async subscribeAndWaitForIdle(
    opencodeSessionId: string,
    linearSessionId: string,
    workdir: string,
  ): Promise<void> {
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

    for await (const event of eventStream.stream) {
      // Log every event for observability
      logOpencodeEvent(event, linearSessionId, opencodeSessionId);

      // Process the event via handler (posts activities to Linear, handles permissions)
      const result = await handler.handleEvent(event);

      // Break if handler signals completion (session.idle or session.error)
      if (result === "break") {
        console.info({
          message: "Session completed",
          stage: "processor",
          linearSessionId,
          opencodeSessionId,
        });
        break;
      }
    }
  }

  /**
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opencodeSessionId: string,
    linearSessionId: string,
    issueId: string,
    workdir: string,
  ): Promise<void> {
    const prompt = event.promptContext ?? "Please help with this issue.";

    console.info({
      message: "Starting new session with prompt",
      stage: "processor",
      linearSessionId,
      opencodeSessionId,
      issueId,
      promptLength: prompt.length,
    });

    // Post sending prompt stage activity
    await this.linear.postStageActivity(linearSessionId, "sending_prompt");

    // Send prompt and subscribe to events concurrently
    // The prompt triggers the AI work, event subscription logs everything
    await Promise.all([
      this.opencodeClient.session.prompt({
        path: { id: opencodeSessionId },
        query: { directory: workdir },
        body: {
          model: {
            providerID: this.config.providerID,
            modelID: this.config.modelID,
          },
          parts: [{ type: "text", text: prompt }],
        },
      }),
      this.subscribeAndWaitForIdle(opencodeSessionId, linearSessionId, workdir),
    ]);

    console.info({
      message: "OpenCode session completed",
      stage: "processor",
      linearSessionId,
      opencodeSessionId,
    });
  }

  /**
   * Handle follow-up prompts
   */
  private async handlePrompted(
    event: AgentSessionEventWebhookPayload,
    opencodeSessionId: string,
    linearSessionId: string,
    issueId: string,
    workdir: string,
  ): Promise<void> {
    // Check for stop signal
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      console.info({
        message: "Stop signal received, aborting session",
        stage: "processor",
        linearSessionId,
        opencodeSessionId,
        issueId,
      });

      await this.opencodeClient.session.abort({
        path: { id: opencodeSessionId },
        query: { directory: workdir },
      });

      await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Work stopped as requested." },
        false,
      );
      return;
    }

    const prompt =
      event.agentActivity?.content?.body ??
      event.promptContext ??
      "Please continue.";

    console.info({
      message: "Sending follow-up prompt",
      stage: "processor",
      linearSessionId,
      opencodeSessionId,
      issueId,
      promptLength: prompt.length,
    });

    // Post sending prompt stage activity
    await this.linear.postStageActivity(linearSessionId, "sending_prompt");

    // Send prompt and subscribe to events concurrently
    await Promise.all([
      this.opencodeClient.session.prompt({
        path: { id: opencodeSessionId },
        query: { directory: workdir },
        body: {
          model: {
            providerID: this.config.providerID,
            modelID: this.config.modelID,
          },
          parts: [{ type: "text", text: prompt }],
        },
      }),
      this.subscribeAndWaitForIdle(opencodeSessionId, linearSessionId, workdir),
    ]);

    console.info({
      message: "Follow-up prompt completed",
      stage: "processor",
      linearSessionId,
      opencodeSessionId,
    });
  }
}
