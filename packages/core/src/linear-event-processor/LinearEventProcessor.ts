import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { Project } from "@opencode-ai/sdk/v2";

import { Result } from "better-result";
import { basename } from "node:path";

import type { LinearService } from "../linear-service/LinearService";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { AgentStateNamespace } from "../state/root";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
  RepoSelectionOption,
  SessionState,
} from "../state/schema";
import type { AgentMode } from "../utils/determineAgentMode";
import type { Logger } from "../utils/logger";

import { KvNotFoundError } from "../kv/errors";
import { LinearForbiddenError } from "../linear-service/errors";
import { findRepoLabel, parseRepoLabel } from "../linear-service/label-parser";
import { buildCreatedPrompt } from "../session/PromptBuilder";
import { saveSessionState } from "../state/session-state";
import { determineAgentMode } from "../utils/determineAgentMode";
import { base64Encode } from "../utils/encode";
import { Log } from "../utils/logger";

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
    const contentBody = readStringField(promptContext["content"], "body");
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
    const contentBody = readStringField(event.agentActivity["content"], "body");
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
      if (normalizedAlias.length > 0 && normalizedResponse.startsWith(normalizedAlias)) {
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
      if (normalizedAlias.length > 0 && hasWordBoundaryMatch(userResponse, normalizedAlias)) {
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

function buildRepoSelectionBody(resolution: ProjectResolution, invalidResponse?: string): string {
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

function matchProjectByRepoName(repositoryName: string, projects: Project[]): Project | null {
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
 * Uses shared issue workspaces and direct state storage.
 * PromptBuilder handles context injection and prompt construction.
 */
export class LinearEventProcessor {
  private readonly config: LinearEventProcessorConfig;

  constructor(
    private readonly agentState: AgentStateNamespace,
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
    config: LinearEventProcessorConfig,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Process a Linear webhook event
   *
   * @param event - The webhook payload from Linear
   */
  async process(event: AgentSessionEventWebhookPayload): Promise<void> {
    const linearSessionId = event.agentSession.id;
    const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
    const issueIdentifier = event.agentSession.issue?.identifier ?? issueId ?? "unknown";
    const log = Log.create({ service: "processor" })
      .tag("issue", issueIdentifier)
      .tag("sessionId", linearSessionId);

    log.info("Processing event", { action: event.action });

    const result = await this.processResult(event, log);
    if (result.isErr()) {
      log.error("Failed to process event", {
        error: result.error.message,
      });
      await this.linear.postError(linearSessionId, result.error);
    }
  }

  private async processResult(
    event: AgentSessionEventWebhookPayload,
    log: Logger,
  ): Promise<Result<void, Error>> {
    return Result.gen(
      async function* (this: LinearEventProcessor) {
        const linearSessionId = event.agentSession.id;
        const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;

        const action = this.toSessionWorktreeAction(event.action);
        if (!action) {
          log.info("Ignoring unsupported agent session action", {
            action: event.action,
          });
          return Result.ok(undefined);
        }

        const pendingSelection = await this.agentState.repoSelection.get(linearSessionId);
        if (pendingSelection.isOk()) {
          yield* Result.await(this.handleRepoSelectionPrompt(event, pendingSelection.value, log));
          return Result.ok(undefined);
        }
        if (!KvNotFoundError.is(pendingSelection.error)) {
          return Result.err(pendingSelection.error);
        }

        const sessionState = await this.agentState.session.get(linearSessionId);
        if (sessionState.isOk() && action === "prompted") {
          log.info("Using existing session project", {
            projectId: sessionState.value.projectId,
            workdir: sessionState.value.workdir,
          });
          yield* Result.await(
            this.processWithProject(
              event,
              {
                id: sessionState.value.projectId,
                worktree: sessionState.value.workdir,
              },
              sessionState.value,
              log,
            ),
          );
          return Result.ok(undefined);
        }
        if (sessionState.isErr() && !KvNotFoundError.is(sessionState.error)) {
          return Result.err(sessionState.error);
        }

        if (!issueId) {
          return Result.err(new Error("Missing issue id"));
        }

        const projectsResult = yield* Result.await(this.opencode.listProjects());
        const projects = projectsResult.projects;
        if (projects.length === 0) {
          return Result.err(
            new Error("No OpenCode projects found. Open the repo in OpenCode first, then retry."),
          );
        }

        const labels = yield* Result.await(this.linear.getIssueLabels(issueId));
        const parsedRepoLabel = parseRepoLabel(labels);
        const repoLabel = findRepoLabel(labels);

        if (!parsedRepoLabel) {
          yield* Result.await(
            this.promptForRepoSelection(
              linearSessionId,
              issueId,
              buildProjectResolution(
                projects,
                repoLabel.status === "invalid" ? "invalid" : "missing",
                repoLabel.status === "invalid" ? repoLabel.label : undefined,
              ),
              readPromptContextText(event.promptContext) ?? undefined,
            ),
          );
          return Result.ok(undefined);
        }

        const matchedProject = matchProjectByRepoName(parsedRepoLabel.repositoryName, projects);
        if (!matchedProject) {
          const unmatchedLabel =
            repoLabel.status === "valid" || repoLabel.status === "invalid"
              ? repoLabel.label
              : undefined;
          yield* Result.await(
            this.promptForRepoSelection(
              linearSessionId,
              issueId,
              buildProjectResolution(projects, "no_match", undefined, unmatchedLabel),
              readPromptContextText(event.promptContext) ?? undefined,
            ),
          );
          return Result.ok(undefined);
        }

        log.info("Using matched OpenCode project", {
          projectId: matchedProject.id,
          worktree: matchedProject.worktree,
        });
        yield* Result.await(
          this.processWithProject(
            sessionState.isOk() ? event : toStartupEvent(event),
            { id: matchedProject.id, worktree: matchedProject.worktree },
            sessionState.isOk() ? sessionState.value : undefined,
            log,
          ),
        );

        return Result.ok(undefined);
      }.bind(this),
    );
  }

  private async processWithProject(
    event: AgentSessionEventWebhookPayload,
    project: ProjectRef,
    sessionState: SessionState | undefined,
    log: Logger,
  ): Promise<Result<void, Error>> {
    return Result.gen(
      async function* (this: LinearEventProcessor) {
        const linearSessionId = event.agentSession.id;
        const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
        let issue: WorktreeIssue = {
          identifier: event.agentSession.issue?.identifier ?? issueId ?? "unknown",
          branchName: readStringField(event.agentSession.issue, "branchName") ?? undefined,
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
          return Result.ok(undefined);
        }

        let workdir = sessionState?.workdir;
        let branchName: string | null = sessionState?.branchName ?? null;
        let opencodeSessionId = sessionState?.opencodeSessionId;
        let isNewSession = false;

        if (
          !workdir ||
          !branchName ||
          !opencodeSessionId ||
          sessionState?.projectId !== project.id
        ) {
          if (!issueId) {
            return Result.err(new Error("Missing issue id"));
          }

          const workspace = yield* Result.await(
            this.getOrCreateIssueWorkspace(
              issueId,
              project,
              issue.branchName ?? null,
              linearSessionId,
              log,
            ),
          );

          branchName = workspace.branchName;
          workdir = workspace.workspaceDirectory;

          const session = yield* Result.await(
            this.opencode.createSession(workdir, workspace.workspaceId),
          );

          opencodeSessionId = session.id;
          isNewSession = true;

          const saved: SessionState = {
            linearSessionId,
            opencodeSessionId,
            organizationId: this.config.organizationId,
            issueId,
            projectId: workspace.projectId,
            branchName,
            workdir,
            lastActivityTime: Date.now(),
          };

          yield* Result.await(saveSessionState(this.agentState, saved));
        } else {
          const session = yield* Result.await(this.opencode.getSession(opencodeSessionId, workdir));
          opencodeSessionId = session.id;
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

        yield* Result.await(
          this.linear.postStageActivity(
            linearSessionId,
            "session_ready",
            `Branch: \`${branchName}\``,
          ),
        );
        const sessionLog = log
          .tag("opencodeSession", opencodeSessionId.slice(0, 8))
          .tag("opencodeSessionId", opencodeSessionId);

        sessionLog.info("OpenCode session ready", {
          workdir,
          isNewSession,
        });

        const encodedWorkdir = base64Encode(workdir);
        const opencodeBaseUrl = this.config.opencodeUrl ?? "http://localhost:4096";
        const externalLink = `${opencodeBaseUrl}/${encodedWorkdir}/session/${opencodeSessionId}`;
        yield* Result.await(this.linear.setExternalLink(linearSessionId, externalLink));

        if (action === "created") {
          yield* Result.await(
            this.handleCreated(
              event,
              opencodeSessionId,
              linearSessionId,
              workdir,
              mode,
              sessionLog,
            ),
          );
          return Result.ok(undefined);
        }

        yield* Result.await(
          this.handlePrompted(event, opencodeSessionId, linearSessionId, workdir, mode, sessionLog),
        );

        return Result.ok(undefined);
      }.bind(this),
    );
  }

  private async getOrCreateIssueWorkspace(
    issueId: string,
    project: ProjectRef,
    branchName: string | null,
    linearSessionId: string,
    log: Logger,
  ): Promise<
    Result<
      {
        workspaceId: string;
        workspaceDirectory: string;
        branchName: string;
        projectId: string;
      },
      Error
    >
  > {
    return this.withIssueWorkspaceLock(issueId, async () =>
      Result.gen(
        async function* (this: LinearEventProcessor) {
          const existing = await this.agentState.issueWorkspace.get(issueId);
          if (existing.isOk()) {
            if (existing.value.projectId !== project.id) {
              return Result.err(
                new Error(
                  `Repo switch unsupported for issue ${issueId}: ${existing.value.projectId} -> ${project.id}`,
                ),
              );
            }

            return Result.ok({
              workspaceId: existing.value.workspaceId,
              workspaceDirectory: existing.value.workspaceDirectory,
              branchName: existing.value.branchName,
              projectId: existing.value.projectId,
            });
          }
          if (!KvNotFoundError.is(existing.error)) {
            return Result.err(existing.error);
          }

          yield* Result.await(this.linear.postStageActivity(linearSessionId, "git_setup"));
          const created = yield* Result.await(
            this.opencode.createWorkspace(project.worktree, branchName, issueId),
          );

          const createdBranch = created.branch ?? branchName;
          if (!createdBranch) {
            const removed = await this.opencode.removeWorkspace(created.id);
            if (removed.isErr()) {
              log.warn("Failed to rollback workspace after missing branch", {
                issueId,
                workspaceId: created.id,
                error: removed.error.message,
                errorType: removed.error._tag,
              });
            }
            return Result.err(new Error(`Missing branch name for issue workspace ${issueId}`));
          }

          const stored = await this.agentState.issueWorkspace.put(issueId, {
            projectId: project.id,
            projectDirectory: project.worktree,
            workspaceId: created.id,
            workspaceDirectory: created.directory,
            branchName: createdBranch,
          });
          if (stored.isErr()) {
            const removed = await this.opencode.removeWorkspace(created.id);
            if (removed.isErr()) {
              log.warn("Failed to rollback workspace after state write error", {
                issueId,
                workspaceId: created.id,
                error: removed.error.message,
                errorType: removed.error._tag,
              });
            }
            return Result.err(stored.error);
          }

          return Result.ok({
            workspaceId: created.id,
            workspaceDirectory: created.directory,
            branchName: createdBranch,
            projectId: project.id,
          });
        }.bind(this),
      ),
    );
  }

  private async withIssueWorkspaceLock<V>(
    issueId: string,
    fn: () => Promise<Result<V, Error>>,
  ): Promise<Result<V, Error>> {
    const locked = await this.agentState.issueWorkspace.withOperationLock(
      `issue-workspace:${issueId}`,
      async () => Result.ok(await fn()),
    );
    if (locked.isErr()) {
      return Result.err(locked.error);
    }

    return locked.value;
  }

  private async promptForRepoSelection(
    linearSessionId: string,
    issueId: string,
    resolution: ProjectResolution,
    promptContext?: string,
    invalidResponse?: string,
  ): Promise<Result<void, Error>> {
    return Result.gen(
      async function* (this: LinearEventProcessor) {
        const pendingSelection: PendingRepoSelection = {
          linearSessionId,
          issueId,
          options: resolution.options,
          promptContext,
          createdAt: Date.now(),
        };

        yield* Result.await(this.agentState.repoSelection.put(linearSessionId, pendingSelection));
        yield* Result.await(
          this.linear.postElicitation(
            linearSessionId,
            buildRepoSelectionBody(resolution, invalidResponse),
            "select",
            {
              options: resolution.options.map((option) => ({
                label: option.label,
                value: option.repoLabel,
              })),
            },
          ),
        );

        return Result.ok(undefined);
      }.bind(this),
    );
  }

  private async handleRepoSelectionPrompt(
    event: AgentSessionEventWebhookPayload,
    pendingSelection: PendingRepoSelection,
    log: Logger,
  ): Promise<Result<void, Error>> {
    return Result.gen(
      async function* (this: LinearEventProcessor) {
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
              (item) => normalizeMatchInput(item.repoLabel) === normalizeMatchInput(normalized),
            );
            return option?.repoLabel ?? null;
          })() ??
          matchOption(userResponse, pendingSelection.options, {
            getLabel: (option) => option.repoLabel,
            getAliases: (option) => [option.label, ...option.aliases],
          });

        if (!selectedLabel) {
          yield* Result.await(
            this.promptForRepoSelection(
              linearSessionId,
              pendingSelection.issueId,
              {
                reason: "missing",
                exampleLabel:
                  pendingSelection.options[0]?.repoLabel ?? "repo:opencode-linear-agent",
                options: pendingSelection.options,
              },
              pendingSelection.promptContext,
              userResponse,
            ),
          );
          return Result.ok(undefined);
        }

        const selectedOption =
          pendingSelection.options.find((option) => option.repoLabel === selectedLabel) ?? null;
        if (!selectedOption) {
          return Result.err(new Error(`Invalid repo label selected: ${selectedLabel}`));
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

        yield* Result.await(
          this.processWithProject(
            toStartupEvent(event, pendingSelection.promptContext),
            {
              id: selectedOption.projectId,
              worktree: selectedOption.worktree,
            },
            undefined,
            log,
          ),
        );
        yield* Result.await(this.agentState.repoSelection.delete(linearSessionId));

        return Result.ok(undefined);
      }.bind(this),
    );
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
  ): Promise<Result<void, Error>> {
    return Result.gen(
      async function* (this: LinearEventProcessor) {
        yield* Result.await(this.linear.postStageActivity(linearSessionId, "sending_prompt"));
        yield* Result.await(
          this.opencode.prompt(opencodeSessionId, workdir, [{ type: "text", text: prompt }], agent),
        );

        log.info("Prompt sent, plugin will handle events", { agent });
        return Result.ok(undefined);
      }.bind(this),
    );
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
  ): Promise<Result<void, Error>> {
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session silently");

      const abortResult = await this.opencode.abortSession(opencodeSessionId, workdir);
      if (Result.isError(abortResult)) {
        log.warn("Failed to abort session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      const stopped = await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Stopped." },
        false,
      );
      return stopped.isErr() ? Result.err(stopped.error) : Result.ok(undefined);
    }

    // Build prompt with mode-specific instructions + issue context + previous context
    const prompt = buildCreatedPrompt(event, mode);

    log.info("Starting new session with prompt", {
      promptLength: prompt.length,
      mode,
    });

    return this.executePrompt(opencodeSessionId, linearSessionId, workdir, prompt, mode, log);
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
  ): Promise<Result<void, Error>> {
    if (event.agentActivity && hasStopSignal(event.agentActivity)) {
      log.info("Stop signal received, aborting session silently");

      const abortResult = await this.opencode.abortSession(opencodeSessionId, workdir);
      if (Result.isError(abortResult)) {
        log.warn("Failed to abort session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      const stopped = await this.linear.postActivity(
        linearSessionId,
        { type: "response", body: "Stopped." },
        false,
      );
      return stopped.isErr() ? Result.err(stopped.error) : Result.ok(undefined);
    }

    return Result.gen(
      async function* (this: LinearEventProcessor) {
        const userResponse = extractPromptedUserResponse(event);
        const pendingPermission = await this.agentState.permission.get(linearSessionId);
        if (pendingPermission.isOk()) {
          yield* Result.await(
            this.handlePermissionResponse(
              pendingPermission.value,
              userResponse,
              opencodeSessionId,
              linearSessionId,
              workdir,
              mode,
              log,
            ),
          );
          return Result.ok(undefined);
        }
        if (!KvNotFoundError.is(pendingPermission.error)) {
          return Result.err(pendingPermission.error);
        }

        const pendingQuestion = await this.agentState.question.get(linearSessionId);
        if (pendingQuestion.isErr() && !KvNotFoundError.is(pendingQuestion.error)) {
          return Result.err(pendingQuestion.error);
        }
        log.info("Checking for pending question", {
          hasPendingQuestion: pendingQuestion.isOk(),
          pendingRequestId: pendingQuestion.isOk() ? pendingQuestion.value.requestId : undefined,
        });

        if (pendingQuestion.isOk()) {
          yield* Result.await(
            this.handleQuestionResponse(
              pendingQuestion.value,
              userResponse,
              opencodeSessionId,
              linearSessionId,
              workdir,
              mode,
              log,
            ),
          );
          return Result.ok(undefined);
        }

        if (userResponse.length === 0) {
          log.info("Empty prompted response, skipping prompt");
          return Result.ok(undefined);
        }

        log.info("Sending follow-up prompt", {
          promptLength: userResponse.length,
          mode,
        });
        yield* Result.await(
          this.executePrompt(opencodeSessionId, linearSessionId, workdir, userResponse, mode, log),
        );

        return Result.ok(undefined);
      }.bind(this),
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
  ): Promise<Result<void, Error>> {
    log.info("Received response while question pending", {
      requestId: pending.requestId,
      responseLength: userResponse.length,
      questionCount: pending.questions.length,
      answeredCount: pending.answers.filter((a) => a !== null).length,
    });

    // Find the first unanswered question
    const answerIndex = pending.answers.findIndex((a) => a === null);

    if (answerIndex === -1) {
      log.warn("All questions already answered - clearing pending and treating as follow-up");
      const removed = await this.agentState.question.delete(linearSessionId);
      if (removed.isErr()) {
        return Result.err(removed.error);
      }
      return this.sendFollowUpPrompt(
        userResponse,
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        log,
      );
    }

    const currentQuestion = pending.questions[answerIndex];
    if (!currentQuestion) {
      log.warn("No current question found at index", { answerIndex });
      const removed = await this.agentState.question.delete(linearSessionId);
      if (removed.isErr()) {
        return Result.err(removed.error);
      }
      return Result.ok(undefined);
    }

    const matchedLabel = matchOption(userResponse, currentQuestion.options, {
      getLabel: (option) => option.label,
      getAliases: (option) => [option.description],
    });

    if (!matchedLabel) {
      log.info("User response doesn't match any option - treating as new prompt", {
        response: userResponse.slice(0, 100),
        availableOptions: currentQuestion.options.map((o) => o.label),
      });
      const removed = await this.agentState.question.delete(linearSessionId);
      if (removed.isErr()) {
        return Result.err(removed.error);
      }
      return this.sendFollowUpPrompt(
        userResponse,
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        log,
      );
    }

    pending.answers[answerIndex] = [matchedLabel];

    log.info("Matched user response to option", {
      userResponse: userResponse.slice(0, 50),
      matchedLabel,
    });

    const allAnswered = pending.answers.every((a) => a !== null);

    if (!allAnswered) {
      const saved = await this.agentState.question.put(linearSessionId, pending);
      if (saved.isErr()) {
        return Result.err(saved.error);
      }
      log.info("Waiting for more question responses", {
        answered: pending.answers.filter((a) => a !== null).length,
        total: pending.questions.length,
      });
      return Result.ok(undefined);
    }

    log.info("All questions answered - replying to OpenCode", {
      answerCount: pending.answers.length,
    });

    const answers = pending.answers.filter((a): a is string[] => a !== null);
    const replyResult = await this.opencode.replyQuestion(pending.requestId, answers, workdir);
    const removed = await this.agentState.question.delete(linearSessionId);
    if (removed.isErr()) {
      return Result.err(removed.error);
    }

    if (replyResult.isErr()) {
      return Result.err(replyResult.error);
    }

    log.info("Question reply sent, plugin will handle events");
    return Result.ok(undefined);
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
  ): Promise<Result<void, Error>> {
    log.info("Received response while permission pending", {
      requestId: pending.requestId,
      responseLength: userResponse.length,
      permission: pending.permission,
    });

    const permissionOptions = ["Approve", "Approve Always", "Reject"];
    const matchedOption = matchOption(userResponse, permissionOptions, {
      getLabel: (option) => option,
    });

    if (!matchedOption) {
      log.info(
        "User response doesn't match any permission option - rejecting and treating as new prompt",
        {
          response: userResponse.slice(0, 100),
        },
      );

      const rejected = await this.opencode.replyPermission(pending.requestId, "reject", workdir);
      if (rejected.isErr()) {
        return Result.err(rejected.error);
      }
      const removed = await this.agentState.permission.delete(linearSessionId);
      if (removed.isErr()) {
        return Result.err(removed.error);
      }
      return this.sendFollowUpPrompt(
        userResponse,
        opencodeSessionId,
        linearSessionId,
        workdir,
        mode,
        log,
      );
    }

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

    const replyResult = await this.opencode.replyPermission(pending.requestId, reply, workdir);
    const removed = await this.agentState.permission.delete(linearSessionId);
    if (removed.isErr()) {
      return Result.err(removed.error);
    }

    if (replyResult.isErr()) {
      return Result.err(replyResult.error);
    }

    log.info("Permission reply sent, plugin will handle events", { reply });
    return Result.ok(undefined);
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
  ): Promise<Result<void, Error>> {
    if (userResponse.length === 0) {
      log.info("Empty follow-up response, skipping prompt");
      return Result.ok(undefined);
    }

    log.info("Sending follow-up prompt", {
      promptLength: userResponse.length,
      mode,
    });

    return this.executePrompt(opencodeSessionId, linearSessionId, workdir, userResponse, mode, log);
  }
}
