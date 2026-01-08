/**
 * Resolves which repository to use for a given Linear issue
 *
 * Strategy:
 * 1. Check issue labels for "repo:" labels
 * 2. Check issue attachments for GitHub repo links
 * 3. Check issue description for GitHub links
 * 4. Fall back to default repo
 */

import type { LinearClient } from "@linear/sdk";
import { parseRepoLabel } from "@linear-opencode-agent/core";
import type { RepoConfig } from "./config";

/**
 * Resolved repository information
 */
export interface ResolvedRepo {
  /** Key in the repos config (or "default" for single repo) */
  key: string;
  /** Repository configuration */
  config: RepoConfig;
}

/**
 * Extract GitHub repo URL from various link formats
 * Returns normalized format: https://github.com/owner/repo
 */
function extractGitHubRepoUrl(url: string): string | null {
  // Match various GitHub URL formats
  const patterns = [
    // https://github.com/owner/repo
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i,
    // git@github.com:owner/repo.git
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const [, owner, repo] = match;
      return `https://github.com/${owner}/${repo}`;
    }
  }

  return null;
}

/**
 * Resolves repository configuration for a given issue
 */
export class RepoResolver {
  constructor(
    private readonly linearClient: LinearClient,
    private readonly repos: Record<string, RepoConfig>,
    private readonly defaultRepoKey?: string,
  ) {}

  /**
   * Resolve the repository for an issue
   *
   * @param issueId - Linear issue ID
   * @returns Resolved repo config, or null if no matching repo found
   */
  async resolve(issueId: string): Promise<ResolvedRepo | null> {
    console.info({
      message: "Resolving repository for issue",
      stage: "repo-resolver",
      issueId,
      availableRepos: Object.keys(this.repos),
    });

    try {
      // Fetch issue with attachments and labels
      const issue = await this.linearClient.issue(issueId);

      // Strategy 1: Check labels for "repo:" label
      const labels = await issue.labels();
      const repoLabelInfo = parseRepoLabel(labels.nodes);
      if (repoLabelInfo) {
        const resolved = this.findRepoByName(repoLabelInfo.repositoryName);
        if (resolved) {
          console.info({
            message: "Resolved repo from label",
            stage: "repo-resolver",
            issueId,
            label: `repo:${repoLabelInfo.organizationName ? `${repoLabelInfo.organizationName}/` : ""}${repoLabelInfo.repositoryName}`,
            repoKey: resolved.key,
          });
          return resolved;
        }

        // If org/repo format, try to find by URL pattern
        if (repoLabelInfo.organizationName) {
          const repoUrl = `https://github.com/${repoLabelInfo.organizationName}/${repoLabelInfo.repositoryName}`;
          const resolvedByUrl = this.findRepoByUrl(repoUrl);
          if (resolvedByUrl) {
            console.info({
              message: "Resolved repo from label (by URL)",
              stage: "repo-resolver",
              issueId,
              repoUrl,
              repoKey: resolvedByUrl.key,
            });
            return resolvedByUrl;
          }
        }

        console.warn({
          message: "Found repo: label but no matching repo config",
          stage: "repo-resolver",
          issueId,
          repoLabel: repoLabelInfo,
          availableRepos: Object.keys(this.repos),
        });
      }

      // Strategy 2: Check attachments for GitHub links
      const attachments = await issue.attachments();
      for (const attachment of attachments.nodes) {
        const url = attachment.url;
        if (!url) {
          continue;
        }

        const repoUrl = extractGitHubRepoUrl(url);
        if (repoUrl) {
          const resolved = this.findRepoByUrl(repoUrl);
          if (resolved) {
            console.info({
              message: "Resolved repo from attachment",
              stage: "repo-resolver",
              issueId,
              attachmentUrl: url,
              repoKey: resolved.key,
            });
            return resolved;
          }
        }
      }

      // Strategy 3: Check issue description for GitHub links
      const description = issue.description ?? "";
      const urlRegex = /https?:\/\/github\.com\/[^\s)>\]]+/gi;
      const matches = description.match(urlRegex);
      if (matches) {
        for (const match of matches) {
          const repoUrl = extractGitHubRepoUrl(match);
          if (repoUrl) {
            const resolved = this.findRepoByUrl(repoUrl);
            if (resolved) {
              console.info({
                message: "Resolved repo from description",
                stage: "repo-resolver",
                issueId,
                foundUrl: match,
                repoKey: resolved.key,
              });
              return resolved;
            }
          }
        }
      }

      // Strategy 4: Fall back to default repo
      if (this.defaultRepoKey && this.repos[this.defaultRepoKey]) {
        console.info({
          message: "Using default repo",
          stage: "repo-resolver",
          issueId,
          repoKey: this.defaultRepoKey,
        });
        return {
          key: this.defaultRepoKey,
          config: this.repos[this.defaultRepoKey],
        };
      }

      // No default, try the first repo if there's only one
      const repoKeys = Object.keys(this.repos);
      if (repoKeys.length === 1) {
        const key = repoKeys[0];
        console.info({
          message: "Using only available repo",
          stage: "repo-resolver",
          issueId,
          repoKey: key,
        });
        return { key, config: this.repos[key] };
      }

      console.warn({
        message: "Could not resolve repository for issue",
        stage: "repo-resolver",
        issueId,
        availableRepos: repoKeys,
      });

      return null;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error({
        message: "Error resolving repository",
        stage: "repo-resolver",
        issueId,
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Find a repo config by matching its remoteUrl
   */
  private findRepoByUrl(githubUrl: string): ResolvedRepo | null {
    const normalizedSearch = githubUrl.toLowerCase().replace(/\.git$/, "");

    for (const [key, config] of Object.entries(this.repos)) {
      const normalizedRepo = config.remoteUrl
        .toLowerCase()
        .replace(/\.git$/, "");
      if (normalizedRepo === normalizedSearch) {
        return { key, config };
      }
    }

    return null;
  }

  /**
   * Find a repo config by matching the repository name
   * Matches against both the config key and the repo name extracted from remoteUrl
   */
  private findRepoByName(repoName: string): ResolvedRepo | null {
    const normalizedName = repoName.toLowerCase();

    for (const [key, config] of Object.entries(this.repos)) {
      // Check if key matches
      if (key.toLowerCase() === normalizedName) {
        return { key, config };
      }

      // Check if repo name from URL matches
      // Extract repo name from URL like https://github.com/owner/repo-name
      const urlMatch = config.remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
      if (urlMatch && urlMatch[1].toLowerCase() === normalizedName) {
        return { key, config };
      }
    }

    return null;
  }

  /**
   * Create a RepoResolver from config
   * Handles both single repo (backward compat) and multi-repo configs
   */
  static fromConfig(
    linearClient: LinearClient,
    config: {
      repo?: RepoConfig;
      repos?: Record<string, RepoConfig>;
      defaultRepo?: string;
    },
  ): RepoResolver {
    let repos: Record<string, RepoConfig> = {};

    if (config.repos) {
      repos = config.repos;
    } else if (config.repo) {
      // Backward compat: single repo becomes "default"
      repos = { default: config.repo };
    }

    return new RepoResolver(
      linearClient,
      repos,
      config.defaultRepo ?? "default",
    );
  }
}
