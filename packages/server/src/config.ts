import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { getAppPaths, type PathEnvironment } from "@opencode-linear-agent/core";

const DEFAULT_WEBHOOK_IPS = [
  "35.231.147.226",
  "35.243.134.228",
  "34.145.29.68",
];

const ConfigFileSchema = z.object({
  webhookServerPublicHostname: z.string().min(1),
  webhookServerPort: z.coerce.number().default(3210),
  opencodeServerUrl: z.string().min(1).default("http://localhost:4096"),

  linearClientId: z.string().min(1),
  linearClientSecret: z.string().min(1),
  linearWebhookSecret: z.string().min(1),
  linearWebhookIps: z.array(z.string()).min(1).default(DEFAULT_WEBHOOK_IPS),
  linearOrganizationId: z.string().optional(),

  projectsPath: z.string().min(1),
});

export type Config = z.infer<typeof ConfigFileSchema>;

function resolveHome(env: PathEnvironment): string {
  if (env.HOME) {
    return env.HOME;
  }
  return homedir();
}

function resolveProjectsPath(
  projectsPath: string,
  env: PathEnvironment,
): string {
  if (!projectsPath.startsWith("~/")) {
    return projectsPath;
  }
  return resolve(resolveHome(env), projectsPath.slice(2));
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: PathEnvironment;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? {
    HOME: process.env.HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  const configPath = options.configPath ?? getAppPaths(env).configFile;

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}. Please create a config file with the necessary configuration values.`,
    );
  }

  const rawConfig = readFileSync(configPath, "utf-8");

  let raw: unknown;
  try {
    raw = JSON.parse(rawConfig);
  } catch (err) {
    throw new Error(`Failed to parse config file at ${configPath}`, {
      cause: err,
    });
  }

  const result = ConfigFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return {
    ...result.data,
    projectsPath: resolveProjectsPath(result.data.projectsPath, env),
  };
}
