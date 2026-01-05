import type { OpencodeClient } from "@opencode-ai/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { LinearAdapter } from "./linear/LinearAdapter";
import type { SessionRepository } from "./session/SessionRepository";
import type { GitOperations } from "./git/GitOperations";
import { SessionManager } from "./session/SessionManager";
import { base64Encode } from "./utils/encode";

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
      // Post git setup stage activity
      await this.linear.postStageActivity(linearSessionId, "git_setup");

      // Get existing state to check for branch
      const existingState =
        await this.sessionManager["repository"].get(linearSessionId);
      const existingBranch = existingState?.branchName;

      // Ensure worktree exists
      const { workdir, branchName } = await this.git.ensureWorktree(
        linearSessionId,
        issueId,
        existingBranch,
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
        );
      } else if (event.action === "prompted") {
        await this.handlePrompted(
          event,
          opencodeSessionId,
          linearSessionId,
          issueId,
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
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opencodeSessionId: string,
    linearSessionId: string,
    issueId: string,
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

    await this.opencodeClient.session.promptAsync({
      path: { id: opencodeSessionId },
      body: {
        model: {
          providerID: this.config.providerID,
          modelID: this.config.modelID,
        },
        parts: [{ type: "text", text: prompt }],
      },
    });

    console.info({
      message: "OpenCode prompt started successfully",
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

    await this.opencodeClient.session.promptAsync({
      path: { id: opencodeSessionId },
      body: {
        model: {
          providerID: this.config.providerID,
          modelID: this.config.modelID,
        },
        parts: [{ type: "text", text: prompt }],
      },
    });

    console.info({
      message: "Follow-up prompt started successfully",
      stage: "processor",
      linearSessionId,
      opencodeSessionId,
    });
  }
}
