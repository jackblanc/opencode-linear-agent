/**
 * Configuration loader for local server
 */

import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { Log } from "@linear-opencode-agent/core";

/**
 * Configuration structure
 */
export interface Config {
  port: number;
  /** Public hostname for this service (e.g., via Cloudflare Tunnel) */
  publicHostname: string;
  opencode: {
    url: string;
  };
  linear: {
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    organizationId: string;
    /** IP addresses allowed to send webhooks (Linear's IPs) */
    webhookIps: string[];
  };
  projectsPath: string;
  paths: {
    /** Directory for persistent data (e.g., /data) */
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
  if (typeof config.publicHostname !== "string") {
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

  const log = Log.create({ service: "config" });

  // Check webhookIps (required array of strings)
  if (!Array.isArray(linear.webhookIps) || linear.webhookIps.length === 0) {
    log.error("linear.webhookIps must be a non-empty array of IP addresses");
    return false;
  }
  for (const ip of linear.webhookIps) {
    if (typeof ip !== "string") {
      log.error("linear.webhookIps must contain only strings");
      return false;
    }
  }

  // Check projectsPath
  if (typeof config.projectsPath !== "string") {
    log.error("projectsPath must be a string");
    return false;
  }

  // Check paths
  const paths = getObject(config, "paths");
  if (!paths || typeof paths.data !== "string") {
    return false;
  }

  return true;
}

/**
 * Load configuration from config.json
 *
 * Looks for config.json in:
 * 1. Current working directory
 * 2. Same directory as this file (packages/server/)
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

  const log = Log.create({ service: "config" });
  log.info("Loading config", { path: configPath });

  const rawConfig: unknown = await configFile.json();

  if (!validateConfig(rawConfig)) {
    throw new Error(
      "Invalid configuration. Please check all required fields are present.",
    );
  }

  // Expand paths
  const config: Config = {
    ...rawConfig,
    projectsPath: expandPath(rawConfig.projectsPath),
    paths: {
      data: expandPath(rawConfig.paths.data),
    },
  };

  return config;
}

/**
 * Get the worker URL from config
 * Public hostname serves on standard HTTPS port 443, so no port needed
 */
export function getWorkerUrl(config: Config): string {
  return `https://${config.publicHostname}`;
}
