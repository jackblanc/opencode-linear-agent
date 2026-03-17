import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { Result } from "better-result";
import {
  findRepoLabel,
  Log,
  parseRepoLabel,
  type LinearService,
  type LinearServiceError,
  type IssueRepositoryCandidate,
} from "@opencode-linear-agent/core";

export interface RepoLabelSuggestion {
  confidence: number | null;
  hostname: string;
  labelValue: string;
  repositoryFullName: string;
  repositoryName: string;
}

export interface MissingRepoLabelResolution {
  status: "needs_repo_label";
  reason: "missing" | "invalid";
  invalidLabel?: string;
  exampleLabel: string;
  suggestions: RepoLabelSuggestion[];
}

interface ResolvedRepoPath {
  status: "resolved";
  path: string;
  repoName: string;
}

type RepoResolution = ResolvedRepoPath | MissingRepoLabelResolution;

function toRepoLabelSuggestion(
  candidate: IssueRepositoryCandidate,
  confidence: number | null,
): RepoLabelSuggestion {
  const parts = candidate.repositoryFullName.split("/");
  const repositoryName =
    parts[parts.length - 1] ?? candidate.repositoryFullName;

  return {
    confidence,
    hostname: candidate.hostname,
    labelValue: `repo:${candidate.repositoryFullName}`,
    repositoryFullName: candidate.repositoryFullName,
    repositoryName,
  };
}

async function getCandidateRepositories(
  projectsPath: string,
): Promise<IssueRepositoryCandidate[]> {
  const result = await Result.tryPromise({
    try: async () => readdir(projectsPath, { withFileTypes: true }),
    catch: (e) => (e instanceof Error ? e.message : String(e)),
  });

  if (Result.isError(result)) {
    return [];
  }

  return result.value
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      hostname: "github.com",
      repositoryFullName: entry.name,
    }));
}

/**
 * Resolve repository path from issue labels
 * - repo:X → projectsPath/X
 * - repo:org/X → projectsPath/X (org ignored)
 * - missing/invalid label → needs_repo_label
 */
export async function resolveRepoPath(
  linear: LinearService,
  issueId: string,
  agentSessionId: string,
  projectsPath: string,
): Promise<Result<RepoResolution, LinearServiceError>> {
  const log = Log.create({ service: "repo-resolver" }).tag("issueId", issueId);

  const labelsResult = await linear.getIssueLabels(issueId);
  if (Result.isError(labelsResult)) {
    return Result.err(labelsResult.error);
  }

  const parsedRepoLabel = parseRepoLabel(labelsResult.value);
  const repoLabel = findRepoLabel(labelsResult.value);

  if (parsedRepoLabel) {
    const repoPath = join(projectsPath, parsedRepoLabel.repositoryName);
    log.info("Resolved repo from label", {
      repoName: parsedRepoLabel.repositoryName,
      repoPath,
    });

    return Result.ok({
      status: "resolved",
      path: repoPath,
      repoName: parsedRepoLabel.repositoryName,
    });
  }

  const candidates = await getCandidateRepositories(projectsPath);
  const suggestionsResult = candidates.length
    ? await linear.getIssueRepositorySuggestions(
        issueId,
        agentSessionId,
        candidates,
      )
    : Result.ok([]);

  const suggestions = Result.isOk(suggestionsResult)
    ? suggestionsResult.value
        .toSorted((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        .map((candidate) =>
          toRepoLabelSuggestion(candidate, candidate.confidence),
        )
    : candidates
        .slice(0, 3)
        .map((candidate) => toRepoLabelSuggestion(candidate, null));

  log.info("Repo label required before session start", {
    reason: repoLabel.status,
    invalidLabel: repoLabel.status === "invalid" ? repoLabel.label : undefined,
    suggestionCount: suggestions.length,
  });

  const reason = repoLabel.status === "invalid" ? "invalid" : "missing";

  return Result.ok({
    status: "needs_repo_label",
    reason,
    invalidLabel: repoLabel.status === "invalid" ? repoLabel.label : undefined,
    exampleLabel: suggestions[0]?.labelValue ?? "repo:opencode-linear-agent",
    suggestions,
  });
}
