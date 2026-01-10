/**
 * Auto-discover git repositories from filesystem
 */

import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { Log } from "@linear-opencode-agent/core";
import type { RepoConfig } from "./config";

/**
 * Execute a git command in a specific directory
 */
async function execGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Check if a directory is a git repository
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const gitDir = join(dirPath, ".git");
    const stats = await stat(gitDir);
    return stats.isDirectory() || stats.isFile(); // Can be file for worktrees
  } catch {
    return false;
  }
}

/**
 * Get the remote URL for a git repository
 */
async function getRemoteUrl(dirPath: string): Promise<string | null> {
  try {
    const result = await execGit(dirPath, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Discover git repositories in a directory
 *
 * Scans the repos directory and builds RepoConfig for each git repository found.
 * The key for each repo is the directory name.
 *
 * @param reposDir - Directory containing repositories (e.g., /home/repos)
 * @returns Map of repo name to RepoConfig
 */
export async function discoverRepos(
  reposDir: string,
): Promise<Record<string, RepoConfig>> {
  const repos: Record<string, RepoConfig> = {};
  const log = Log.create({ service: "repo-discovery" });

  try {
    const entries = await readdir(reposDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dirPath = join(reposDir, entry.name);

      // Check if it's a git repo
      if (!(await isGitRepo(dirPath))) {
        continue;
      }

      // Get remote URL
      const remoteUrl = await getRemoteUrl(dirPath);
      if (!remoteUrl) {
        log.warn("Found git repo but no remote URL", {
          repo: entry.name,
          path: dirPath,
        });
        continue;
      }

      repos[entry.name] = {
        localPath: dirPath,
        remoteUrl,
      };

      log.info("Discovered repository", {
        repo: entry.name,
        path: dirPath,
        remoteUrl,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error("Failed to discover repositories", {
      reposDir,
      error: errorMessage,
    });
  }

  return repos;
}
