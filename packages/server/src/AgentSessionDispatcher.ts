import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { Result } from "better-result";
import {
  LinearEventProcessor,
  LinearForbiddenError,
  Log,
  findRepoLabel,
  parseRepoLabel,
  type LinearService,
  type OpencodeService,
  type PendingRepoSelection,
  type RepoSelectionOption,
  type SessionRepository,
} from "@opencode-linear-agent/core";
import {
  resolveRepoPath,
  type MissingRepoLabelResolution,
} from "./RepoResolver";

interface AgentSessionDispatcherConfig {
  organizationId: string;
  projectsPath: string;
}

type ProcessWithResolvedRepo = (
  event: AgentSessionEventWebhookPayload,
  repoPath: string,
) => Promise<void>;

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

function matchRepoSelectionOption(
  userResponse: string,
  options: RepoSelectionOption[],
): string | null {
  const normalizedResponse = normalizeMatchInput(userResponse);
  if (normalizedResponse.length === 0) {
    return null;
  }

  for (const opt of options) {
    if (normalizeMatchInput(opt.labelValue) === normalizedResponse) {
      return opt.labelValue;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      if (normalizeMatchInput(alias) === normalizedResponse) {
        return opt.labelValue;
      }
    }
  }

  for (const opt of options) {
    if (normalizedResponse.startsWith(normalizeMatchInput(opt.labelValue))) {
      return opt.labelValue;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      const normalizedAlias = normalizeMatchInput(alias);
      if (normalizedResponse.startsWith(normalizedAlias)) {
        return opt.labelValue;
      }
    }
  }

  for (const opt of options) {
    if (
      hasWordBoundaryMatch(userResponse, normalizeMatchInput(opt.labelValue))
    ) {
      return opt.labelValue;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      const normalizedAlias = normalizeMatchInput(alias);
      if (hasWordBoundaryMatch(userResponse, normalizedAlias)) {
        return opt.labelValue;
      }
    }
  }

  return null;
}

function matchExactRepoSelectionOption(
  userResponse: string,
  options: RepoSelectionOption[],
): string | null {
  const normalizedResponse = normalizeMatchInput(userResponse);
  if (normalizedResponse.length === 0) {
    return null;
  }

  for (const opt of options) {
    if (normalizeMatchInput(opt.labelValue) === normalizedResponse) {
      return opt.labelValue;
    }
  }

  for (const opt of options) {
    for (const alias of opt.aliases) {
      if (normalizeMatchInput(alias) === normalizedResponse) {
        return opt.labelValue;
      }
    }
  }

  return null;
}

function buildRepoSelectionOptions(
  resolution: MissingRepoLabelResolution,
): RepoSelectionOption[] {
  return resolution.suggestions.map((suggestion) => {
    const aliases = [
      suggestion.labelValue,
      suggestion.repositoryFullName,
      suggestion.repositoryName,
    ];

    return {
      label: suggestion.repositoryFullName,
      labelValue: suggestion.labelValue,
      aliases,
    };
  });
}

function buildRepoLabelErrorBody(
  resolution: MissingRepoLabelResolution,
): string {
  const lines = [
    resolution.reason === "invalid"
      ? `Missing valid repository label. Replace \`${resolution.invalidLabel ?? "repo:"}\` with a valid \`repo:*\` label before re-running.`
      : "Missing repository label. Add a `repo:*` label before re-running.",
    "",
    `Example: \`${resolution.exampleLabel}\``,
  ];

  if (resolution.suggestions.length > 0) {
    lines.push(
      "",
      "Suggested labels:",
      ...resolution.suggestions.map((suggestion) =>
        suggestion.confidence === null
          ? `- \`${suggestion.labelValue}\``
          : `- \`${suggestion.labelValue}\` (${Math.round(suggestion.confidence * 100)}%)`,
      ),
    );
  }

  lines.push("", "I stopped before creating any OpenCode session or worktree.");

  return lines.join("\n");
}

function buildRepoSelectionBody(
  resolution: MissingRepoLabelResolution,
  invalidResponse?: string,
): string {
  const lines = [
    resolution.reason === "invalid"
      ? `Replace invalid label \`${resolution.invalidLabel ?? "repo:"}\` by picking a repository or replying with a label like \`${resolution.exampleLabel}\`.`
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

  if (parsed.organizationName) {
    return `repo:${parsed.organizationName}/${parsed.repositoryName}`;
  }

  return `repo:${parsed.repositoryName}`;
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

async function processWithRepo(
  event: AgentSessionEventWebhookPayload,
  repoPath: string,
  linear: LinearService,
  opencode: OpencodeService,
  sessionRepository: SessionRepository,
  config: AgentSessionDispatcherConfig,
  processWithResolvedRepo?: ProcessWithResolvedRepo,
): Promise<void> {
  if (processWithResolvedRepo) {
    await processWithResolvedRepo(event, repoPath);
    return;
  }

  const processor = new LinearEventProcessor(
    opencode,
    linear,
    sessionRepository,
    repoPath,
    {
      organizationId: config.organizationId,
    },
  );

  await processor.process(event);
}

async function reportMissingRepoLabel(
  linear: LinearService,
  linearSessionId: string,
  resolution: MissingRepoLabelResolution,
): Promise<void> {
  await linear.postError(
    linearSessionId,
    new Error(buildRepoLabelErrorBody(resolution)),
  );
}

async function promptForRepoSelection(
  linear: LinearService,
  sessionRepository: SessionRepository,
  linearSessionId: string,
  issueId: string,
  resolution: MissingRepoLabelResolution,
  promptContext?: string,
  invalidResponse?: string,
): Promise<void> {
  const options = buildRepoSelectionOptions(resolution);
  const pendingSelection: PendingRepoSelection = {
    linearSessionId,
    issueId,
    options,
    promptContext,
    createdAt: Date.now(),
  };

  await sessionRepository.savePendingRepoSelection(pendingSelection);
  await linear.postElicitation(
    linearSessionId,
    buildRepoSelectionBody(resolution, invalidResponse),
    "select",
    {
      options: options.map((option) => ({
        label: option.label,
        value: option.labelValue,
      })),
    },
  );
}

async function handleRepoSelectionPrompt(
  event: AgentSessionEventWebhookPayload,
  pendingSelection: PendingRepoSelection,
  linear: LinearService,
  opencode: OpencodeService,
  sessionRepository: SessionRepository,
  config: AgentSessionDispatcherConfig,
  processWithResolvedRepo?: ProcessWithResolvedRepo,
): Promise<void> {
  const linearSessionId = event.agentSession.id;
  const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
  const issueIdentifier =
    event.agentSession.issue?.identifier ?? issueId ?? "unknown";

  const log = Log.create({ service: "dispatcher" })
    .tag("organizationId", config.organizationId)
    .tag("issue", issueIdentifier);

  const userResponse = extractPromptedUserResponse(event);
  const selectedLabel =
    matchExactRepoSelectionOption(userResponse, pendingSelection.options) ??
    normalizeRepoLabelInput(userResponse) ??
    matchRepoSelectionOption(userResponse, pendingSelection.options);

  if (!selectedLabel) {
    await promptForRepoSelection(
      linear,
      sessionRepository,
      linearSessionId,
      pendingSelection.issueId,
      {
        status: "needs_repo_label",
        reason: "missing",
        exampleLabel:
          pendingSelection.options[0]?.labelValue ??
          "repo:opencode-linear-agent",
        suggestions: pendingSelection.options.map((option) => ({
          confidence: null,
          hostname: "github.com",
          labelValue: option.labelValue,
          repositoryFullName: option.label,
          repositoryName: option.label.replace(/^.*\//, ""),
        })),
      },
      pendingSelection.promptContext,
      userResponse,
    );
    return;
  }

  const parsed = findRepoLabel([{ name: selectedLabel }]);
  if (parsed.status !== "valid") {
    await linear.postError(
      linearSessionId,
      new Error(`Invalid repo label selected: ${selectedLabel}`),
    );
    return;
  }

  const setLabelResult = await linear.setIssueRepoLabel(
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

    const note = await linear.postActivity(linearSessionId, {
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

  await processWithRepo(
    toStartupEvent(event, pendingSelection.promptContext),
    `${config.projectsPath}/${parsed.value.repositoryName}`,
    linear,
    opencode,
    sessionRepository,
    config,
    processWithResolvedRepo,
  );

  await sessionRepository.deletePendingRepoSelection(linearSessionId);
}

export async function dispatchAgentSessionEvent(
  event: AgentSessionEventWebhookPayload,
  linear: LinearService,
  opencode: OpencodeService,
  sessionRepository: SessionRepository,
  config: AgentSessionDispatcherConfig,
  processWithResolvedRepo?: ProcessWithResolvedRepo,
): Promise<void> {
  const linearSessionId = event.agentSession.id;
  const issueId = event.agentSession.issue?.id ?? event.agentSession.issueId;
  const issueIdentifier =
    event.agentSession.issue?.identifier ?? issueId ?? "unknown";

  const log = Log.create({ service: "dispatcher" })
    .tag("organizationId", config.organizationId)
    .tag("issue", issueIdentifier);

  const pendingSelection =
    await sessionRepository.getPendingRepoSelection(linearSessionId);
  if (pendingSelection) {
    await handleRepoSelectionPrompt(
      event,
      pendingSelection,
      linear,
      opencode,
      sessionRepository,
      config,
      processWithResolvedRepo,
    );
    return;
  }

  const sessionState = await sessionRepository.get(linearSessionId);
  if (event.action === "prompted" && sessionState?.repoDirectory) {
    log.info("Using existing session repo directory", {
      repoPath: sessionState.repoDirectory,
    });
    await processWithRepo(
      event,
      sessionState.repoDirectory,
      linear,
      opencode,
      sessionRepository,
      config,
      processWithResolvedRepo,
    );
    return;
  }

  if (!issueId) {
    await linear.postError(linearSessionId, new Error("Missing issue id"));
    return;
  }

  const resolveResult = await resolveRepoPath(
    linear,
    issueId,
    linearSessionId,
    config.projectsPath,
  );

  if (Result.isError(resolveResult)) {
    log.error("Failed to resolve repository", {
      error: resolveResult.error.message,
    });
    await linear.postError(linearSessionId, resolveResult.error);
    return;
  }

  const resolved = resolveResult.value;
  if (resolved.status === "needs_repo_label") {
    if (resolved.suggestions.length > 0) {
      await promptForRepoSelection(
        linear,
        sessionRepository,
        linearSessionId,
        issueId,
        resolved,
        readPromptContextText(event.promptContext) ?? undefined,
      );
      return;
    }

    await reportMissingRepoLabel(linear, linearSessionId, resolved);
    return;
  }

  log.info("Using repository path", {
    repoPath: resolved.path,
    repoName: resolved.repoName,
  });

  await processWithRepo(
    sessionState ? event : toStartupEvent(event),
    resolved.path,
    linear,
    opencode,
    sessionRepository,
    config,
    processWithResolvedRepo,
  );
}
