import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { Project } from "@opencode-ai/sdk/v2";
import { Result } from "better-result";
import { basename } from "node:path";
import type { LinearService } from "../linear-service/LinearService";
import type { SessionRepository } from "../state/SessionRepository";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
  RepoSelectionOption,
} from "../state/schema";
import { SessionManager } from "../session/SessionManager";
import {
  type AgentMode,
  determineAgentMode,
} from "../utils/determineAgentMode";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import { base64Encode } from "../utils/encode";
import { Log, type Logger } from "../utils/logger";
import { buildCreatedPrompt } from "../session/PromptBuilder";
import { LinearForbiddenError } from "../linear-service/errors";
import { findRepoLabel, parseRepoLabel } from "../linear-service/label-parser";

/**
 * Configuration for the LinearEventProcessor
 */
interface LinearEventProcessorConfig {
  /** OpenCode server URL for external links (should be localhost for security) */
  opencodeUrl?: string;
  /** Linear organization ID for OAuth token lookup */
  organizationId: string;
}

const DEFAULT_CONFIG: Pick<LinearEventProcessorConfig, "opencodeUrl"> = {
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

  return "";
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

interface MatchOptionConfig<T> {
  getLabel: (option: T) => string;
  getAliases?: (option: T) => string[];
  exactOnly?: boolean;
}

interface ProjectResolution {
  reason: "missing" | "invalid" | "no_match";
  invalidLabel?: string;
  unmatchedLabel?: string;
  exampleLabel: string;
  options: RepoSelectionOption[];
}

interface ProjectRef {
  id: string;
  worktree: string;
}

interface WorktreeIssue {
  identifier: string;
  branchName?: string;
}

type SessionWorktreeAction = "created" | "prompted";

function matchOption<T>(
  userResponse: string,
  options: T[],
  config: MatchOptionConfig<T>,
): string | null {
  const normalizedResponse = normalizeMatchInput(userResponse);
  if (normalizedResponse.length === 0) {
    return null;
  }

  for (const opt of options) {
    const label = config.getLabel(opt);
    if (normalizeMatchInput(label) === normalizedResponse) {
      return label;
    }
  }

  for (const opt of options) {
    const aliases = config.getAliases?.(opt) ?? [];
    for (const alias of aliases) {
      if (normalizeMatchInput(alias) === normalizedResponse) {
        return config.getLabel(opt);
      }
    }
  }

  if (config.exactOnly) {
    return null;
  }

  for (const opt of options) {
    const label = config.getLabel(opt);
    if (normalizedResponse.startsWith(normalizeMatchInput(label))) {
      return label;
    }
  }

  for (const opt of options) {
    const aliases = config.getAliases?.(opt) ?? [];
    for (const alias of aliases) {
      const normalizedAlias = normalizeMatchInput(alias);
      if (
        normalizedAlias.length > 0 &&
        normalizedResponse.startsWith(normalizedAlias)
      ) {
        return config.getLabel(opt);
      }
    }
  }

  for (const opt of options) {
    const label = config.getLabel(opt);
    if (hasWordBoundaryMatch(userResponse, normalizeMatchInput(label))) {
      return label;
    }
  }

  for (const opt of options) {
    const aliases = config.getAliases?.(opt) ?? [];
    for (const alias of aliases) {
      const normalizedAlias = normalizeMatchInput(alias);
      if (
        normalizedAlias.length > 0 &&
        hasWordBoundaryMatch(userResponse, normalizedAlias)
      ) {
        return config.getLabel(opt);
      }
    }
  }

  return null;
}

function getProjectRepositoryName(project: Project): string {
  return basename(project.worktree);
}

function getProjectLabel(project: Project): string {
  const name = project.name?.trim();
  return name && name.length > 0 ? name : getProjectRepositoryName(project);
}

function toRepoSelectionOption(project: Project): RepoSelectionOption {
  const repositoryName = getProjectRepositoryName(project);
  const label = getProjectLabel(project);
  return {
    label,
    projectId: project.id,
    worktree: project.worktree,
    repoLabel: `repo:${repositoryName}`,
    aliases: [label, repositoryName],
  };
}

function buildRepoSelectionBody(
  resolution: ProjectResolution,
  invalidResponse?: string,
): string {
  const lines = [
    resolution.reason === "invalid"
      ? `Replace invalid label \`${resolution.invalidLabel ?? "repo:"}\` by picking a repository or replying with a label like \`${resolution.exampleLabel}\`.`
      : resolution.reason === "no_match"
        ? `No OpenCode project matches \`${resolution.unmatchedLabel ?? "the current repo label"}\`. Pick a project or reply with a label like \`${resolution.exampleLabel}\`.`
        : `Pick a repository or reply with a label like \`${resolution.exampleLabel}\`.`,
  ];

  if (invalidResponse) {
    lines.push(
      "",
      `I couldn't use \`${invalidResponse}\`. Reply with \`repo:name\`, \`name\`, or pick one below.`,
    );
  }

  return lines.join("\n");
}

function normalizeRepoLabelInput(userResponse: string): string | null {
  const trimmed = userResponse.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const label = trimmed.startsWith("repo:") ? trimmed : `repo:${trimmed}`;
  const parsed = parseRepoLabel([{ name: label }]);
  if (!parsed) {
    return null;
  }

  return `repo:${parsed.repositoryName}`;
}

function matchProjectByRepoName(
  repositoryName: string,
  projects: Project[],
): Project | null {
  const target = normalizeMatchInput(repositoryName);
  for (const project of projects) {
    if (normalizeMatchInput(getProjectLabel(project)) === target) {
      return project;
    }
    if (normalizeMatchInput(getProjectRepositoryName(project)) === target) {
      return project;
    }
  }

  return null;
}

function buildProjectResolution(
  projects: Project[],
  reason: ProjectResolution["reason"],
  invalidLabel?: string,
  unmatchedLabel?: string,
): ProjectResolution {
  const options = projects.map(toRepoSelectionOption);
  return {
    reason,
    invalidLabel,
    unmatchedLabel,
    exampleLabel: options[0]?.repoLabel ?? "repo:opencode-linear-agent",
    options,
  };
}

function toStartupEvent(
  event: AgentSessionEventWebhookPayload,
  promptContext?: string,
): AgentSessionEventWebhookPayload {
  return {
    ...event,
    action: "created",
    promptContext: promptContext ?? event.promptContext,
  };
}

/**
 * Main entry point for processing Linear webhook events.
 *
 * This class is platform-agnostic and receives all dependencies via constructor injection.
 * Uses OpenCode's native worktree and project APIs.
 *
 * Delegates to specialized managers:
 * - SessionManager: OpenCode session lifecycle
 * - PromptBuilder: Context injection and prompt construction
 */
export class LinearEventProcessor {
  private readonly sessionManager: SessionManager;
  private readonly config: LinearEventProcessorConfig;

  constructor(
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
    private readonly sessions: SessionRepository,
    config: LinearEventProcessorConfig,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.sessionManager = new SessionManager(opencode, sessions);
  }

  /**
   * Process a Linear webhook event
   *
   * @param event - The webhook payload from Linear
   */
  async process(event: AgentSessionEventWebhookPayload): Promise<void> {
    const linearSessionId = event.agentSession.id;
    const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
    const issueIdentifier =
      event.agentSession.issue?.identifier ?? issueId ?? "unknown";
    const log = Log.create({ service: "processor" })
      .tag("issue", issueIdentifier)
      .tag("sessionId", linearSessionId);

    log.info("Processing event", { action: event.action });

    const action = this.toSessionWorktreeAction(event.action);
    if (!action) {
      log.info("Ignoring unsupported agent session action", {
        action: event.action,
      });
      return;
    }

    const pendingSelection =
      await this.sessions.getPendingRepoSelection(linearSessionId);
    if (pendingSelection) {
      await this.handleRepoSelectionPrompt(event, pendingSelection, log);
      return;
    }

    const sessionState = await this.sessions.get(linearSessionId);
    if (action === "prompted" && sessionState) {
      log.info("Using existing session project", {
        projectId: sessionState.projectId,
        workdir: sessionState.workdir,
      });
      const ok = await this.processWithProject(
        event,
        {
          id: sessionState.projectId,
          worktree: sessionState.workdir,
        },
        log,
      );
      if (!ok) {
        await this.linear.postError(
          linearSessionId,
          new Error("Session startup failed"),
        );
      }
      return;
    }

    if (!issueId) {
      await this.linear.postError(
        linearSessionId,
        new Error("Missing issue id"),
      );
      return;
    }

    const projectsResult = await this.opencode.listProjects();
    if (Result.isError(projectsResult)) {
      log.error("Failed to list OpenCode projects", {
        error: projectsResult.error.message,
      });
      await this.linear.postError(linearSessionId, projectsResult.error);
      return;
    }

    const projects = projectsResult.value.projects;
    if (projects.length === 0) {
      await this.linear.postError(
        linearSessionId,
        new Error(
          "No OpenCode projects found. Open the repo in OpenCode first, then retry.",
        ),
      );
      return;
    }

    const labelsResult = await this.linear.getIssueLabels(issueId);
    if (Result.isError(labelsResult)) {
      await this.linear.postError(linearSessionId, labelsResult.error);
      return;
    }

    const parsedRepoLabel = parseRepoLabel(labelsResult.value);
    const repoLabel = findRepoLabel(labelsResult.value);

    if (!parsedRepoLabel) {
      await this.promptForRepoSelection(
        linearSessionId,
        issueId,
        buildProjectResolution(
          projects,
          repoLabel.status === "invalid" ? "invalid" : "missing",
          repoLabel.status === "invalid" ? repoLabel.label : undefined,
        ),
        readPromptContextText(event.promptContext) ?? undefined,
      );
      return;
    }

    const matchedProject = matchProjectByRepoName(
      parsedRepoLabel.repositoryName,
      projects,
    );

    if (!matchedProject) {
      const unmatchedLabel =
        repoLabel.status === "valid" || repoLabel.status === "invalid"
          ? repoLabel.label
          : undefined;
      await this.promptForRepoSelection(
        linearSessionId,
        issueId,
        buildProjectResolution(projects, "no_match", undefined, unmatchedLabel),
        readPromptContextText(event.promptContext) ?? undefined,
      );
      return;
    }

    log.info("Using matched OpenCode project", {
      projectId: matchedProject.id,
      worktree: matchedProject.worktree,
    });

    const ok = await this.processWithProject(
      sessionState ? event : toStartupEvent(event),
      { id: matchedProject.id, worktree: matchedProject.worktree },
      log,
    );
    if (!ok) {
      await this.linear.postError(
        linearSessionId,
        new Error("Session startup failed"),
      );
    }
  }

  private async processWithProject(
    event: AgentSessionEventWebhookPayload,
    project: ProjectRef,
    log: Logger,
  ): Promise<boolean> {
    const linearSessionId = event.agentSession.id;
    const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
    const sessionState = await this.sessions.get(linearSessionId);
    let issue: WorktreeIssue = {
      identifier: event.agentSession.issue?.identifier ?? issueId ?? "unknown",
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

    const action = this.toSessionWorktreeAction(event.action);
    if (!action) {
      return true;
    }

    let workdir = sessionState?.workdir;
    let branchName = sessionState?.branchName;

    if (!workdir || !branchName || sessionState?.projectId !== project.id) {
      await this.linear.postStageActivity(linearSessionId, "git_setup");
      const worktreeName = this.buildWorktreeName(issue, linearSessionId);
      const worktreeResult = await this.opencode.createWorktree(
        project.worktree,
        worktreeName,
      );

      if (Result.isError(worktreeResult)) {
        await this.linear.postError(linearSessionId, worktreeResult.error);
        return false;
      }

      workdir = worktreeResult.value.directory;
      branchName = worktreeResult.value.branch;
    }

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

    await this.linear.postStageActivity(
      linearSessionId,
      "session_ready",
      `Branch: \`${branchName}\``,
    );

    const sessionResult = await this.sessionManager.getOrCreateSession(
      linearSessionId,
      this.config.organizationId,
      issueId ?? "unknown",
      project.id,
      branchName,
      workdir,
    );

    if (Result.isError(sessionResult)) {
      log.error("Error getting/creating session", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });
      await this.linear.postError(linearSessionId, sessionResult.error);
      return false;
    }

    const session = sessionResult.value;
    const opencodeSessionId = session.opencodeSessionId;
    const sessionLog = log
      .tag("opencodeSession", opencodeSessionId.slice(0, 8))
      .tag("opencodeSessionId", opencodeSessionId);

    sessionLog.info("OpenCode session ready", {
      workdir,
      isNewSession: session.isNewSession,
    });

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
          sessionLog,
        );
        return true;
      case "prompted":
        await this.handlePrompted(
          event,
          opencodeSessionId,
          linearSessionId,
          workdir,
          mode,
          sessionLog,
        );
        return true;
    }
  }

  private async promptForRepoSelection(
    linearSessionId: string,
    issueId: string,
    resolution: ProjectResolution,
    promptContext?: string,
    invalidResponse?: string,
  ): Promise<void> {
    const pendingSelection: PendingRepoSelection = {
      linearSessionId,
      issueId,
      options: resolution.options,
      promptContext,
      createdAt: Date.now(),
    };

    await this.sessions.savePendingRepoSelection(pendingSelection);
    await this.linear.postElicitation(
      linearSessionId,
      buildRepoSelectionBody(resolution, invalidResponse),
      "select",
      {
        options: resolution.options.map((option) => ({
          label: option.label,
          value: option.repoLabel,
        })),
      },
    );
  }

  private async handleRepoSelectionPrompt(
    event: AgentSessionEventWebhookPayload,
    pendingSelection: PendingRepoSelection,
    log: Logger,
  ): Promise<void> {
    const linearSessionId = event.agentSession.id;
    const userResponse = extractPromptedUserResponse(event);
    const selectedLabel =
      matchOption(userResponse, pendingSelection.options, {
        getLabel: (option) => option.repoLabel,
        getAliases: (option) => [option.label, ...option.aliases],
        exactOnly: true,
      }) ??
      (() => {
        const normalized = normalizeRepoLabelInput(userResponse);
        if (!normalized) {
          return null;
        }

        const option = pendingSelection.options.find(
          (item) =>
            normalizeMatchInput(item.repoLabel) ===
            normalizeMatchInput(normalized),
        );
        return option?.repoLabel ?? null;
      })() ??
      matchOption(userResponse, pendingSelection.options, {
        getLabel: (option) => option.repoLabel,
        getAliases: (option) => [option.label, ...option.aliases],
      });

    if (!selectedLabel) {
      await this.promptForRepoSelection(
        linearSessionId,
        pendingSelection.issueId,
        {
          reason: "missing",
          exampleLabel:
            pendingSelection.options[0]?.repoLabel ??
            "repo:opencode-linear-agent",
          options: pendingSelection.options,
        },
        pendingSelection.promptContext,
        userResponse,
      );
      return;
    }

    const selectedOption =
      pendingSelection.options.find(
        (option) => option.repoLabel === selectedLabel,
      ) ?? null;
    if (!selectedOption) {
      await this.linear.postError(
        linearSessionId,
        new Error(`Invalid repo label selected: ${selectedLabel}`),
      );
      return;
    }

    const setLabelResult = await this.linear.setIssueRepoLabel(
      pendingSelection.issueId,
      selectedLabel,
    );
    if (Result.isError(setLabelResult)) {
      const noteBody =
        setLabelResult.error instanceof LinearForbiddenError
          ? `Warning: couldn't sync issue repo label to Linear because this agent can't update labels, but startup will continue using local repo \`${selectedLabel}\`. Update the issue label manually if needed.`
          : `Warning: couldn't sync issue repo label to Linear, but startup will continue using local repo \`${selectedLabel}\`. Update the issue label manually if needed. Error: ${setLabelResult.error.message}`;

      log.error("Failed to set selected repo label", {
        labelValue: selectedLabel,
        error: setLabelResult.error.message,
        errorType: setLabelResult.error._tag,
      });

      const note = await this.linear.postActivity(linearSessionId, {
        type: "response",
        body: noteBody,
      });

      if (Result.isError(note)) {
        log.warn("Failed to post repo label sync warning", {
          labelValue: selectedLabel,
          error: note.error.message,
          errorType: note.error._tag,
        });
      }
    }

    const startupOk = await this.processWithProject(
      toStartupEvent(event, pendingSelection.promptContext),
      {
        id: selectedOption.projectId,
        worktree: selectedOption.worktree,
      },
      log,
    );

    if (startupOk) {
      await this.sessions.deletePendingRepoSelection(linearSessionId);
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

    // Build prompt with mode-specific instructions + issue context + previous context
    const prompt = buildCreatedPrompt(event, mode);

    log.info("Starting new session with prompt", {
      promptLength: prompt.length,
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
        log,
      );
      return;
    }

    if (userResponse.length === 0) {
      log.info("Empty prompted response, skipping prompt");
      return;
    }

    log.info("Sending follow-up prompt", {
      promptLength: userResponse.length,
      mode,
    });

    // Send prompt (fire-and-forget - plugin handles events)
    await this.executePrompt(
      opencodeSessionId,
      linearSessionId,
      workdir,
      userResponse,
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
        log,
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

    const matchedLabel = matchOption(userResponse, currentQuestion.options, {
      getLabel: (option) => option.label,
      getAliases: (option) => [option.description],
    });

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
    log: Logger,
  ): Promise<void> {
    log.info("Received response while permission pending", {
      requestId: pending.requestId,
      responseLength: userResponse.length,
      permission: pending.permission,
    });

    // Map user responses to permission reply types
    const permissionOptions = ["Approve", "Approve Always", "Reject"];
    const matchedOption = matchOption(userResponse, permissionOptions, {
      getLabel: (option) => option,
    });

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

    // Reply sent - plugin handles subsequent events
    log.info("Permission reply sent, plugin will handle events", { reply });
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
    log: Logger,
  ): Promise<void> {
    if (userResponse.length === 0) {
      log.info("Empty follow-up response, skipping prompt");
      return;
    }

    log.info("Sending follow-up prompt", {
      promptLength: userResponse.length,
      mode,
    });

    // Send prompt (fire-and-forget - plugin handles events)
    await this.executePrompt(
      opencodeSessionId,
      linearSessionId,
      workdir,
      userResponse,
      mode,
      log,
    );
  }

  private buildWorktreeName(
    issue: WorktreeIssue,
    linearSessionId: string,
  ): string {
    const shortLinearSessionId = linearSessionId.slice(0, 8).toLowerCase();
    if (issue.branchName) {
      return `${shortLinearSessionId}-${issue.branchName}`;
    }

    const safeIssue = issue.identifier
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    return `${safeIssue}-${shortLinearSessionId}`;
  }
}
