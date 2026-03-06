import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";
import { Log } from "@opencode-linear-agent/core";

const DEFAULT_WEBHOOK_IPS = [
  "35.231.147.226",
  "35.243.134.228",
  "34.145.29.68",
];

const ConfigSchema = z.object({
  port: z.coerce.number(),
  publicHostname: z.string(),
  opencode: z.object({
    url: z.string(),
  }),
  linear: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    webhookSecret: z.string(),
    organizationId: z.string().optional(),
    webhookIps: z.array(z.string()).min(1),
  }),
  projectsPath: z.string(),
});

export type Config = z.infer<typeof ConfigSchema>;

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const log = Log.create({ service: "config" });
  log.info("Loading config from environment variables");

  const webhookIpsRaw = process.env["LINEAR_WEBHOOK_IPS"];
  const webhookIps = webhookIpsRaw
    ? webhookIpsRaw.split(",").map((ip) => ip.trim())
    : DEFAULT_WEBHOOK_IPS;

  const raw = {
    port: process.env["PORT"] ?? "3210",
    publicHostname: requiredEnv("PUBLIC_HOSTNAME"),
    opencode: {
      url: process.env["OPENCODE_URL"] ?? "http://localhost:4096",
    },
    linear: {
      clientId: requiredEnv("LINEAR_CLIENT_ID"),
      clientSecret: requiredEnv("LINEAR_CLIENT_SECRET"),
      webhookSecret: requiredEnv("LINEAR_WEBHOOK_SECRET"),
      organizationId: process.env["LINEAR_ORGANIZATION_ID"],
      webhookIps,
    },
    projectsPath: requiredEnv("PROJECTS_PATH"),
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return {
    ...result.data,
    projectsPath: expandPath(result.data.projectsPath),
  };
}

export function getWorkerUrl(config: Config): string {
  return `https://${config.publicHostname}`;
}

export function getDataDir(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  return join(
    xdgDataHome ? expandPath(xdgDataHome) : join(homedir(), ".local/share"),
    "opencode-linear-agent",
  );
}
