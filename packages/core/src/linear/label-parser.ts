/**
 * Parses Linear labels to extract repository information from "repo:" labels
 *
 * Supported formats:
 * - "repo:my-repo" -> { repositoryName: "my-repo" }
 * - "repo:org/my-repo" -> { repositoryName: "my-repo", organizationName: "org" }
 */

export interface ParsedRepoLabel {
  repositoryName: string;
  organizationName?: string;
}

export interface LinearLabelLike {
  name: string;
}

/**
 * Parses Linear labels to extract repository information from "repo:" labels
 *
 * @param labels Array of objects with a name property (Linear labels)
 * @returns ParsedRepoLabel if a valid repo label is found, null otherwise
 */
export function parseRepoLabel(
  labels: LinearLabelLike[],
): ParsedRepoLabel | null {
  const repoLabel = labels.find((label) => label.name.startsWith("repo:"));

  if (!repoLabel) {
    return null;
  }

  const repoPath = repoLabel.name.slice(5); // Remove "repo:" prefix

  if (!repoPath.trim()) {
    return null;
  }

  // Check if it includes organization (format: org/repo)
  if (repoPath.includes("/")) {
    const [organizationName, repositoryName] = repoPath.split("/", 2);

    if (!organizationName?.trim() || !repositoryName?.trim()) {
      return null;
    }

    return {
      organizationName: organizationName.trim(),
      repositoryName: repositoryName.trim(),
    };
  }

  // Simple format: just the repository name
  return {
    repositoryName: repoPath.trim(),
  };
}
