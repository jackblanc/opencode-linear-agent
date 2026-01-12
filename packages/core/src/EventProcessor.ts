import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { Result } from "better-result";
import type { LinearService } from "./linear/LinearService";
import type { SessionRepository } from "./session/SessionRepository";
import { SessionManager } from "./session/SessionManager";
import { SSEEventHandler } from "./SSEEventHandler";
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
 * Configuration for the EventProcessor
 */
export interface EventProcessorConfig {
  /** Command to run after worktree creation (e.g., "bun install") */
  startCommand?: string;
  /** OpenCode server URL for external links (should be localhost for security) */
  opencodeUrl?: string;
}

const DEFAULT_CONFIG: EventProcessorConfig = {
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
 */
export class EventProcessor {
  private readonly sessionManager: SessionManager;
  private readonly config: EventProcessorConfig;

  constructor(
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
    sessions: SessionRepository,
    private readonly repoDirectory: string,
    config?: Partial<EventProcessorConfig>,
  ) {
    this.sessionManager = new SessionManager(opencode, sessions);
    this.config = { ...DEFAULT_CONFIG, ...config };
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

    // Get existing state for this specific Linear session
    const existingState =
      await this.sessionManager["repository"].get(linearSessionId);

    let workdir: string;
    let branchName: string;

    if (existingState?.workdir) {
      // Same Linear session - reuse everything
      workdir = existingState.workdir;
      branchName = existingState.branchName;

      log.info("Reusing existing session worktree", { workdir, branchName });
    } else {
      // New Linear session - check if there's an existing worktree for this issue
      const existingWorktree =
        await this.sessionManager["repository"].findWorktreeByIssue(issue);

      if (existingWorktree) {
        // Reuse worktree from a previous session on the same issue
        workdir = existingWorktree.workdir;
        branchName = existingWorktree.branchName;

        log.info("Reusing worktree from previous session on same issue", {
          workdir,
          branchName,
        });
      } else {
        // No existing worktree - create one via OpenCode
        await this.linear.postStageActivity(linearSessionId, "git_setup");

        log.info("Creating worktree via OpenCode", {
          repoDirectory: this.repoDirectory,
        });

        const worktreeResult = await this.opencode.createWorktree(
          this.repoDirectory,
          issue,
          this.config.startCommand,
        );

        if (Result.isError(worktreeResult)) {
          log.error("Error creating worktree", {
            error: worktreeResult.error.message,
            errorType: worktreeResult.error._tag,
          });
          await this.linear.postError(linearSessionId, worktreeResult.error);
          return;
        }

        workdir = worktreeResult.value.directory;
        branchName = worktreeResult.value.branch;

        log.info("Worktree created", { workdir, branchName });
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
        issue,
        workdir,
        session.previousContext,
        log,
      );
    } else if (event.action === "prompted") {
      await this.handlePrompted(
        event,
        opcodeSessionId,
        linearSessionId,
        issue,
        workdir,
        session.previousContext,
        log,
      );
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
  ): Promise<void> {
    log.info("Subscribing to OpenCode event stream");

    const eventStream = await this.opencode.subscribe(workdir);

    // Create the SSE event handler to process events and post to Linear
    const handler = new SSEEventHandler(
      this.linear,
      linearSessionId,
      opencodeSessionId,
      this.opencode,
      log.clone().tag("service", "sse-handler"),
      workdir,
    );

    for await (const event of eventStream.stream) {
      // Log every event for observability
      logOpencodeEvent(event, log);

      // Process the event via handler (posts activities to Linear, handles permissions)
      const result = await handler.handleEvent(event);

      // Break if handler signals completion (session.idle or session.error)
      if (result.action === "break") {
        log.info("Session completed");
        break;
      }
    }
  }

  /**
   * Execute a prompt and wait for completion
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

    // Send prompt and subscribe to events concurrently
    await Promise.all([
      this.opencode.prompt(opcodeSessionId, workdir, [
        { type: "text", text: prompt },
      ]),
      this.subscribeAndWaitForCompletion(
        opcodeSessionId,
        linearSessionId,
        workdir,
        log,
      ),
    ]);

    log.info("OpenCode session completed");
  }

  /**
   * Build issue context header from webhook payload
   */
  private buildIssueContext(event: AgentSessionEventWebhookPayload): string {
    const issue = event.agentSession.issue;
    if (!issue) {
      return "";
    }

    const parts: string[] = [
      `# Linear Issue: ${issue.identifier}`,
      "",
      `**Title:** ${issue.title}`,
    ];

    if (issue.url) {
      parts.push(`**URL:** ${issue.url}`);
    }

    parts.push("", "---", "");

    return parts.join("\n");
  }

  /**
   * Handle new session creation
   */
  private async handleCreated(
    event: AgentSessionEventWebhookPayload,
    opcodeSessionId: string,
    linearSessionId: string,
    _issue: string,
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

    // Build context: issue header + previous context (if any) + Linear's promptContext
    const issueContext = this.buildIssueContext(event);
    const basePrompt = event.promptContext ?? "Please help with this issue.";
    const prompt = `${issueContext}${previousContext ?? ""}${basePrompt}`;

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
    _issue: string,
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

    const basePrompt =
      event.agentActivity?.content?.body ??
      event.promptContext ??
      "Please continue.";

    // If session was recreated, inject issue context + previous context
    // Otherwise, just use the base prompt (agent already has context from initial prompt)
    let prompt: string;
    if (previousContext) {
      const issueContext = this.buildIssueContext(event);
      prompt = `${issueContext}${previousContext}${basePrompt}`;
    } else {
      prompt = basePrompt;
    }

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
}
