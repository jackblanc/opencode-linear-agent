/**
 * Parses Linear labels to extract repository information from "repo:" labels
 *
 * Supported formats:
 * - "repo:my-repo" -> { repositoryName: "my-repo" }
 * - "repo:org/my-repo" -> { repositoryName: "my-repo", organizationName: "org" }
 */

interface ParsedRepoLabel {
  repositoryName: string;
  organizationName?: string;
}

interface LinearLabelLike {
  name: string;
}

type RepoLabelMatch =
  | { status: "missing" }
  | { status: "invalid"; label: string }
  | { status: "valid"; label: string; value: ParsedRepoLabel };

/**
 * Parses Linear labels to extract repository information from "repo:" labels
 *
 * @param labels Array of objects with a name property (Linear labels)
 * @returns ParsedRepoLabel if a valid repo label is found, null otherwise
 */
export function findRepoLabel(labels: LinearLabelLike[]): RepoLabelMatch {
  const repoLabel = labels.find((label) => label.name.startsWith("repo:"));

  if (!repoLabel) {
    return { status: "missing" };
  }

  const repoPath = repoLabel.name.slice(5); // Remove "repo:" prefix

  if (!repoPath.trim()) {
    return { status: "invalid", label: repoLabel.name };
  }

  // Check if it includes organization (format: org/repo)
  if (repoPath.includes("/")) {
    const [organizationName, repositoryName] = repoPath.split("/", 2);

    if (!organizationName?.trim() || !repositoryName?.trim()) {
      return { status: "invalid", label: repoLabel.name };
    }

    return {
      status: "valid",
      label: repoLabel.name,
      value: {
        organizationName: organizationName.trim(),
        repositoryName: repositoryName.trim(),
      },
    };
  }

  // Simple format: just the repository name
  return {
    status: "valid",
    label: repoLabel.name,
    value: {
      repositoryName: repoPath.trim(),
    },
  };
}

export function parseRepoLabel(labels: LinearLabelLike[]): ParsedRepoLabel | null {
  const result = findRepoLabel(labels);

  if (result.status !== "valid") {
    return null;
  }

  return result.value;
}
