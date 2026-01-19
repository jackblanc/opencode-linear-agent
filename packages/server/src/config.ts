/**
 * Configuration loader for local server
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { z } from "zod";
import { Log } from "@linear-opencode-agent/core";

/**
 * Zod schema for server configuration
 */
const ConfigSchema = z.object({
  port: z.number({ message: "port must be a number" }),
  publicHostname: z.string({ message: "publicHostname must be a string" }),
  opencode: z.object({
    url: z.string({ message: "opencode.url must be a string" }),
  }),
  linear: z.object({
    clientId: z.string({ message: "linear.clientId must be a string" }),
    clientSecret: z.string({ message: "linear.clientSecret must be a string" }),
    webhookSecret: z.string({
      message: "linear.webhookSecret must be a string",
    }),
    organizationId: z.string({
      message: "linear.organizationId must be a string",
    }),
    webhookIps: z
      .array(
        z.string({ message: "linear.webhookIps must contain only strings" }),
      )
      .min(1, {
        message: "linear.webhookIps must be a non-empty array of IP addresses",
      }),
  }),
  projectsPath: z.string({ message: "projectsPath must be a string" }),
});

/**
 * Configuration structure
 */
export type Config = z.infer<typeof ConfigSchema>;

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
 * Parse and validate config with user-friendly error messages
 */
function parseConfig(data: unknown): Config {
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
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
  const validatedConfig = parseConfig(rawConfig);

  // Expand paths
  return {
    ...validatedConfig,
    projectsPath: expandPath(validatedConfig.projectsPath),
  };
}

/**
 * Get the worker URL from config
 * Public hostname serves on standard HTTPS port 443, so no port needed
 */
export function getWorkerUrl(config: Config): string {
  return `https://${config.publicHostname}`;
}

/**
 * Get the data directory for persistent storage
 *
 * Auto-detects environment:
 * - Docker: /data (created by Dockerfile, volume mounted)
 * - Local: ~/.local/share/linear-opencode-agent (XDG-compliant)
 */
export function getDataDir(): string {
  // Docker environment has /data created by Dockerfile
  if (existsSync("/data")) {
    return "/data";
  }
  // Local: XDG-compliant path
  return join(homedir(), ".local/share/linear-opencode-agent");
}
