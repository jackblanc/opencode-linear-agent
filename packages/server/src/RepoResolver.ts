/**
 * Resolves which repository to use for a given Linear issue
 *
 * Strategy:
 * 1. Check issue labels for "repo:" labels
 * 2. Check issue attachments for GitHub repo links
 * 3. Check issue description for GitHub links
 * 4. Fall back to default repo
 */

import { Result } from "better-result";
import type { LinearService } from "@linear-opencode-agent/core";
import { parseRepoLabel, Log } from "@linear-opencode-agent/core";
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
    private readonly linear: LinearService,
    private readonly repos: Record<string, RepoConfig>,
    private readonly defaultRepoKey?: string,
  ) {}

  /**
   * Resolve the repository for an issue
   *
   * @param issueId - Linear issue ID
   * @returns Result containing resolved repo config, or null if no matching repo found
   */
  async resolve(issueId: string): Promise<Result<ResolvedRepo | null, Error>> {
    const log = Log.create({ service: "repo-resolver" }).tag(
      "issueId",
      issueId,
    );

    log.info("Resolving repository for issue", {
      availableRepos: Object.keys(this.repos),
    });

    // Strategy 1: Check labels for "repo:" label
    const labelsResult = await this.linear.getIssueLabels(issueId);
    if (Result.isError(labelsResult)) {
      return Result.err(labelsResult.error);
    }

    const repoLabelInfo = parseRepoLabel(labelsResult.value);
    if (repoLabelInfo) {
      const resolved = this.findRepoByName(repoLabelInfo.repositoryName);
      if (resolved) {
        log.info("Resolved repo from label", {
          label: `repo:${repoLabelInfo.organizationName ? `${repoLabelInfo.organizationName}/` : ""}${repoLabelInfo.repositoryName}`,
          repoKey: resolved.key,
        });
        return Result.ok(resolved);
      }

      // If org/repo format, try to find by URL pattern
      if (repoLabelInfo.organizationName) {
        const repoUrl = `https://github.com/${repoLabelInfo.organizationName}/${repoLabelInfo.repositoryName}`;
        const resolvedByUrl = this.findRepoByUrl(repoUrl);
        if (resolvedByUrl) {
          log.info("Resolved repo from label (by URL)", {
            repoUrl,
            repoKey: resolvedByUrl.key,
          });
          return Result.ok(resolvedByUrl);
        }
      }

      log.warn("Found repo: label but no matching repo config", {
        repoLabel: repoLabelInfo,
        availableRepos: Object.keys(this.repos),
      });
    }

    // Strategy 2: Check attachments for GitHub links
    const attachmentsResult = await this.linear.getIssueAttachments(issueId);
    if (Result.isError(attachmentsResult)) {
      return Result.err(attachmentsResult.error);
    }

    for (const attachment of attachmentsResult.value) {
      const url = attachment.url;
      if (!url) {
        continue;
      }

      const repoUrl = extractGitHubRepoUrl(url);
      if (repoUrl) {
        const resolved = this.findRepoByUrl(repoUrl);
        if (resolved) {
          log.info("Resolved repo from attachment", {
            attachmentUrl: url,
            repoKey: resolved.key,
          });
          return Result.ok(resolved);
        }
      }
    }

    // Strategy 3: Check issue description for GitHub links
    const issueResult = await this.linear.getIssue(issueId);
    if (Result.isError(issueResult)) {
      return Result.err(issueResult.error);
    }

    const description = issueResult.value.description ?? "";
    const urlRegex = /https?:\/\/github\.com\/[^\s)>\]]+/gi;
    const matches = description.match(urlRegex);
    if (matches) {
      for (const match of matches) {
        const repoUrl = extractGitHubRepoUrl(match);
        if (repoUrl) {
          const resolved = this.findRepoByUrl(repoUrl);
          if (resolved) {
            log.info("Resolved repo from description", {
              foundUrl: match,
              repoKey: resolved.key,
            });
            return Result.ok(resolved);
          }
        }
      }
    }

    // Strategy 4: Fall back to default repo
    if (this.defaultRepoKey && this.repos[this.defaultRepoKey]) {
      log.info("Using default repo", { repoKey: this.defaultRepoKey });
      return Result.ok({
        key: this.defaultRepoKey,
        config: this.repos[this.defaultRepoKey],
      });
    }

    // No default, try the first repo if there's only one
    const repoKeys = Object.keys(this.repos);
    if (repoKeys.length === 1) {
      const key = repoKeys[0];
      log.info("Using only available repo", { repoKey: key });
      return Result.ok({ key, config: this.repos[key] });
    }

    log.warn("Could not resolve repository for issue", {
      availableRepos: repoKeys,
    });

    return Result.ok(null);
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
    linear: LinearService,
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

    return new RepoResolver(linear, repos, config.defaultRepo ?? "default");
  }
}
