/**
 * Configuration loader for local server
 */

import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

/**
 * Configuration structure
 */
export interface Config {
  port: number;
  tailscaleHostname: string;
  opencode: {
    url: string;
  };
  linear: {
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    organizationId: string;
  };
  github: {
    token: string;
  };
  repo: {
    localPath: string;
    remoteUrl: string;
  };
  paths: {
    worktrees: string;
    data: string;
  };
}

/**
 * Expand ~ to home directory in a path
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Helper to check if a value is a non-null object
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Helper to get a property as a nested object
 */
function getObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = obj[key];
  return isObject(value) ? value : null;
}

/**
 * Validate required fields in config
 */
function validateConfig(config: unknown): config is Config {
  if (!isObject(config)) {
    return false;
  }

  // Check required top-level fields
  if (typeof config.port !== "number") {
    return false;
  }
  if (typeof config.tailscaleHostname !== "string") {
    return false;
  }

  // Check opencode
  const opencode = getObject(config, "opencode");
  if (!opencode || typeof opencode.url !== "string") {
    return false;
  }

  // Check linear
  const linear = getObject(config, "linear");
  if (
    !linear ||
    typeof linear.clientId !== "string" ||
    typeof linear.clientSecret !== "string" ||
    typeof linear.webhookSecret !== "string" ||
    typeof linear.organizationId !== "string"
  ) {
    return false;
  }

  // Check github
  const github = getObject(config, "github");
  if (!github || typeof github.token !== "string") {
    return false;
  }

  // Check repo
  const repo = getObject(config, "repo");
  if (
    !repo ||
    typeof repo.localPath !== "string" ||
    typeof repo.remoteUrl !== "string"
  ) {
    return false;
  }

  // Check paths
  const paths = getObject(config, "paths");
  if (
    !paths ||
    typeof paths.worktrees !== "string" ||
    typeof paths.data !== "string"
  ) {
    return false;
  }

  return true;
}

/**
 * Load configuration from config.json
 *
 * Looks for config.json in:
 * 1. Current working directory
 * 2. Same directory as this file (packages/local/)
 */
export async function loadConfig(): Promise<Config> {
  const configPaths = [
    resolve(process.cwd(), "config.json"),
    resolve(dirname(import.meta.dir), "config.json"),
  ];

  let configFile: Bun.BunFile | null = null;
  let configPath: string | null = null;

  // Check each config path in parallel, then find the first existing one
  const existsResults = await Promise.all(
    configPaths.map(async (path) => ({
      path,
      file: Bun.file(path),
      exists: await Bun.file(path).exists(),
    })),
  );

  for (const result of existsResults) {
    if (result.exists) {
      configFile = result.file;
      configPath = result.path;
      break;
    }
  }

  if (!configFile || !configPath) {
    throw new Error(
      `Configuration file not found. Looked in:\n${configPaths.join("\n")}\n\nCopy config.example.json to config.json and fill in your values.`,
    );
  }

  console.info(`Loading config from: ${configPath}`);

  const rawConfig: unknown = await configFile.json();

  if (!validateConfig(rawConfig)) {
    throw new Error(
      "Invalid configuration. Please check all required fields are present.",
    );
  }

  // Expand paths
  const config: Config = {
    ...rawConfig,
    repo: {
      ...rawConfig.repo,
      localPath: expandPath(rawConfig.repo.localPath),
    },
    paths: {
      worktrees: expandPath(rawConfig.paths.worktrees),
      data: expandPath(rawConfig.paths.data),
    },
  };

  return config;
}

/**
 * Get the worker URL from config
 * Tailscale Funnel serves on standard HTTPS port 443, so no port needed
 */
export function getWorkerUrl(config: Config): string {
  return `https://${config.tailscaleHostname}`;
}
