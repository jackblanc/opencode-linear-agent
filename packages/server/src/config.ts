import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { getConfigPath, getStorePath } from "@opencode-linear-agent/core";

const DEFAULT_WEBHOOK_IPS = [
  "35.231.147.226",
  "35.243.134.228",
  "34.145.29.68",
];

const DEFAULT_OPENCODE_SERVER_HOSTNAME = "127.0.0.1";
const DEFAULT_OPENCODE_SERVER_PORT = 4096;
export const DEFAULT_OPENCODE_SERVER_URL = `http://${DEFAULT_OPENCODE_SERVER_HOSTNAME}:${DEFAULT_OPENCODE_SERVER_PORT}`;
export const WEBHOOK_SERVICE_LABEL = "com.opencode-linear-agent.server";
export const OPENCODE_SERVICE_LABEL = "com.opencode-linear-agent.opencode";

const ConfigFileSchema = z.object({
  webhookServerPublicHostname: z.string().min(1),
  webhookServerPort: z.coerce.number().default(3210),
  opencodeServerUrl: z.string().min(1).default(DEFAULT_OPENCODE_SERVER_URL),

  linearClientId: z.string().min(1),
  linearClientSecret: z.string().min(1),
  linearWebhookSecret: z.string().min(1),
  linearWebhookIps: z.array(z.string()).min(1).default(DEFAULT_WEBHOOK_IPS),
  linearOrganizationId: z.string().optional(),

  projectsPath: z.string().min(1).transform(resolveUserPath),
});

export type Config = z.infer<typeof ConfigFileSchema>;

export interface AppPaths {
  dataDir: string;
  launchAgentsDir: string;
  webhookServicePlistPath: string;
  opencodeServicePlistPath: string;
  webhookLogPath: string;
  webhookErrorLogPath: string;
  opencodeLogPath: string;
  opencodeErrorLogPath: string;
}

export interface LoadConfigOptions {
  configPath?: string;
}

function resolveUserPath(path: string): string {
  if (!path.startsWith("~/")) {
    return path;
  }
  return resolve(homedir(), path.slice(2));
}

export function getAppPaths(): AppPaths {
  const dataDir = getServerDataDir();
  const launchAgentsDir = resolve(homedir(), "Library", "LaunchAgents");
  return {
    dataDir,
    launchAgentsDir,
    webhookServicePlistPath: join(
      launchAgentsDir,
      `${WEBHOOK_SERVICE_LABEL}.plist`,
    ),
    opencodeServicePlistPath: join(
      launchAgentsDir,
      `${OPENCODE_SERVICE_LABEL}.plist`,
    ),
    webhookLogPath: join(dataDir, "launchd.log"),
    webhookErrorLogPath: join(dataDir, "launchd.err"),
    opencodeLogPath: join(dataDir, "opencode.launchd.log"),
    opencodeErrorLogPath: join(dataDir, "opencode.launchd.err"),
  };
}

export function getManagedOpencodeHostAndPort(config: Config): {
  hostname: string;
  port: number;
} {
  if (!URL.canParse(config.opencodeServerUrl)) {
    return {
      hostname: DEFAULT_OPENCODE_SERVER_HOSTNAME,
      port: DEFAULT_OPENCODE_SERVER_PORT,
    };
  }
  const url = new URL(config.opencodeServerUrl);
  if (url.protocol !== "http:") {
    return {
      hostname: DEFAULT_OPENCODE_SERVER_HOSTNAME,
      port: DEFAULT_OPENCODE_SERVER_PORT,
    };
  }
  const hostname = url.hostname;
  const port = Number.parseInt(
    url.port || `${DEFAULT_OPENCODE_SERVER_PORT}`,
    10,
  );
  if (
    (hostname === "127.0.0.1" || hostname === "localhost") &&
    Number.isInteger(port)
  ) {
    return {
      hostname:
        hostname === "localhost" ? DEFAULT_OPENCODE_SERVER_HOSTNAME : hostname,
      port,
    };
  }
  return {
    hostname: DEFAULT_OPENCODE_SERVER_HOSTNAME,
    port: DEFAULT_OPENCODE_SERVER_PORT,
  };
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

function getServerDataDir(): string {
  return dirname(getStorePath());
}

function formatLogTimestamp(now: Date): string {
  const [head, tail] = now.toISOString().split(".");
  const ms = tail?.slice(0, 3);
  if (!head || !ms) {
    return "unknown";
  }
  return `${head.replaceAll("-", "").replaceAll(":", "")}.${ms}Z`;
}

export function getLogDir(): string {
  return join(getServerDataDir(), "log");
}

export function createServerLogPath(
  now = new Date(),
  pid = process.pid,
): string {
  return join(getLogDir(), `server-${formatLogTimestamp(now)}-p${pid}.log`);
}
