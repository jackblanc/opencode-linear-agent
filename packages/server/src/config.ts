import { homedir } from "node:os";
import path, { resolve } from "node:path";
import { z } from "zod";

import { xdgConfig } from "xdg-basedir";
import { existsSync, readFileSync } from "node:fs";

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
      if (projectsPath.startsWith("~/")) {
        return resolve(homedir(), projectsPath.slice(2));
      }
      return projectsPath;
    }),
});

export type Config = z.infer<typeof ConfigFileSchema>;

export const APPLICATION_DIRECTORY = "opencode-linear-agent";

export function loadConfig(): Config {
  if (!xdgConfig) {
    throw new Error(
      "Failed to find directory for config storage. Please ensure HOME or XDG_CONFIG_HOME environment variable is set.",
    );
  }

  const configPath = path.join(xdgConfig, APPLICATION_DIRECTORY, "config.json");
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
