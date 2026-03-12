import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { getConfigPath } from "@opencode-linear-agent/core";

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

  projectsPath: z
    .string()
    .min(1)
    .transform((projectsPath) => {
      if (!projectsPath.startsWith("~/")) {
        return projectsPath;
      }
      return resolve(homedir(), projectsPath.slice(2));
    }),
});

export type Config = z.infer<typeof ConfigFileSchema>;

export interface LoadConfigOptions {
  configPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const configPath = options.configPath ?? getConfigPath();

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

  return result.data;
}
