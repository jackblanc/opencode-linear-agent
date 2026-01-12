import { join } from "node:path";
import { Result } from "better-result";
import {
  parseRepoLabel,
  Log,
  type LinearService,
  type LinearServiceError,
} from "@linear-opencode-agent/core";

export interface ResolvedRepo {
  path: string;
  repoName: string | null;
}

/**
 * Resolve repository path from issue labels
 * - repo:X → projectsPath/X
 * - repo:org/X → projectsPath/X (org ignored)
 * - no label → projectsPath (no worktree)
 */
export async function resolveRepoPath(
  linear: LinearService,
  issueId: string,
  projectsPath: string,
): Promise<Result<ResolvedRepo, LinearServiceError>> {
  const log = Log.create({ service: "repo-resolver" }).tag("issueId", issueId);

  const labelsResult = await linear.getIssueLabels(issueId);
  if (Result.isError(labelsResult)) {
    return Result.err(labelsResult.error);
  }

  const repoLabel = parseRepoLabel(labelsResult.value);

  if (!repoLabel) {
    log.info("No repo label, using projectsPath root", { projectsPath });
    return Result.ok({ path: projectsPath, repoName: null });
  }

  const repoPath = join(projectsPath, repoLabel.repositoryName);
  log.info("Resolved repo from label", {
    repoName: repoLabel.repositoryName,
    repoPath,
  });

  return Result.ok({ path: repoPath, repoName: repoLabel.repositoryName });
}
