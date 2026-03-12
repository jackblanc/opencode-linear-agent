import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

import type { Config } from "./config";
import {
  DEFAULT_OPENCODE_SERVER_URL,
  getAppPaths,
  getManagedOpencodeHostAndPort,
  OPENCODE_SERVICE_LABEL,
  WEBHOOK_SERVICE_LABEL,
} from "./config";

export type ManagedServiceName = "webhook" | "opencode";
export type ServiceInstallState = "unsupported" | "absent" | "installed";
export type ServiceRuntimeState = "running" | "stopped" | "unknown";
export type OpenCodeReuseState =
  | "reachable_configured_url"
  | "launchd_service"
  | "listener"
  | "absent";

export interface ManagedServiceDefinition {
  name: ManagedServiceName;
  label: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  programArguments: string[];
}

export interface ManagedServiceStatus {
  name: ManagedServiceName;
  label: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  installState: ServiceInstallState;
  runtimeState: ServiceRuntimeState;
  pid: number | null;
  lastExitStatus: number | null;
}

export interface ServiceActionResult {
  ok: boolean;
  reason: "ok" | "unsupported_platform" | "missing_plist" | "launchctl_failed";
  status: ManagedServiceStatus;
  stdout?: string;
  stderr?: string;
}

export interface OpenCodeDetectionStatus {
  state: OpenCodeReuseState;
  recommendedAction: "reuse" | "offer_managed_service";
  configuredUrl: string;
  reachableUrl: string | null;
  launchdLabel: string | null;
}

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: string[]) => Promise<CommandOutput>;
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const CURRENT_UID = process.getuid?.() ?? 0;
const LAUNCHD_DOMAIN = `gui/${CURRENT_UID}`;

function createUnsupportedStatus(
  service: ManagedServiceDefinition,
): ManagedServiceStatus {
  return {
    name: service.name,
    label: service.label,
    plistPath: service.plistPath,
    stdoutPath: service.stdoutPath,
    stderrPath: service.stderrPath,
    installState: "unsupported",
    runtimeState: "unknown",
    pid: null,
    lastExitStatus: null,
  };
}

function createAbsentStatus(
  service: ManagedServiceDefinition,
): ManagedServiceStatus {
  return {
    name: service.name,
    label: service.label,
    plistPath: service.plistPath,
    stdoutPath: service.stdoutPath,
    stderrPath: service.stderrPath,
    installState: "absent",
    runtimeState: "stopped",
    pid: null,
    lastExitStatus: null,
  };
}

function parseInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseRuntimeState(output: string): ServiceRuntimeState {
  const match = output.match(/\bstate = ([^\n]+)/);
  const state = match?.[1]?.trim();
  if (state === "running") {
    return "running";
  }
  if (state === "waiting" || state === "exited") {
    return "stopped";
  }
  return "unknown";
}

function parseLaunchctlPrint(
  service: ManagedServiceDefinition,
  output: string,
): ManagedServiceStatus {
  return {
    name: service.name,
    label: service.label,
    plistPath: service.plistPath,
    stdoutPath: service.stdoutPath,
    stderrPath: service.stderrPath,
    installState: "installed",
    runtimeState: parseRuntimeState(output),
    pid: parseInteger(output.match(/\bpid = (\d+)/)?.[1]),
    lastExitStatus: parseInteger(
      output.match(/\blast exit code = (-?\d+)/)?.[1],
    ),
  };
}

function isMissingServiceMessage(output: string): boolean {
  return (
    output.includes("Could not find service") ||
    output.includes("Could not find specified service") ||
    output.includes("service not found")
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderLaunchdPlist(service: ManagedServiceDefinition): string {
  const args = service.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${service.label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(service.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(service.stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function isLaunchdSupported(platform = process.platform): boolean {
  return platform === "darwin";
}

export function getManagedServiceDefinitions(input: {
  config: Config;
  agentExecutableCommand: string[];
  opencodeExecutablePath: string;
}): Record<ManagedServiceName, ManagedServiceDefinition> {
  const paths = getAppPaths();
  const opencode = getManagedOpencodeHostAndPort(input.config);
  return {
    webhook: {
      name: "webhook",
      label: WEBHOOK_SERVICE_LABEL,
      plistPath: paths.webhookServicePlistPath,
      stdoutPath: paths.webhookLogPath,
      stderrPath: paths.webhookErrorLogPath,
      programArguments: [...input.agentExecutableCommand, "serve"],
    },
    opencode: {
      name: "opencode",
      label: OPENCODE_SERVICE_LABEL,
      plistPath: paths.opencodeServicePlistPath,
      stdoutPath: paths.opencodeLogPath,
      stderrPath: paths.opencodeErrorLogPath,
      programArguments: [
        input.opencodeExecutablePath,
        "serve",
        "--port",
        `${opencode.port}`,
        "--hostname",
        opencode.hostname,
      ],
    },
  };
}

export async function resolveAgentExecutableCommand(): Promise<string[]> {
  if (process.argv[1] && isAbsolute(process.argv[1])) {
    return process.execPath.endsWith("/bun") ||
      process.execPath.endsWith("\\bun")
      ? [process.execPath, process.argv[1]]
      : [process.execPath];
  }
  return [process.execPath];
}

async function resolveExecutableFromPath(name: string): Promise<string | null> {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }
  const dirs = pathValue.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    const ok = await access(candidate, fsConstants.X_OK)
      .then(() => true)
      .catch(() => false);
    if (ok) {
      return candidate;
    }
  }
  return null;
}

export async function getLaunchdServiceStatus(
  service: ManagedServiceDefinition,
  runner: CommandRunner,
  platform = process.platform,
): Promise<ManagedServiceStatus> {
  if (!isLaunchdSupported(platform)) {
    return createUnsupportedStatus(service);
  }
  const out = await runner([
    "launchctl",
    "print",
    `${LAUNCHD_DOMAIN}/${service.label}`,
  ]);
  if (out.exitCode === 0) {
    return parseLaunchctlPrint(service, out.stdout);
  }
  if (isMissingServiceMessage(`${out.stdout}\n${out.stderr}`)) {
    return createAbsentStatus(service);
  }
  return {
    ...parseLaunchctlPrint(service, out.stdout),
    runtimeState: "unknown",
  };
}

async function ensureServiceDirectories(
  service: ManagedServiceDefinition,
): Promise<void> {
  await mkdir(dirname(service.plistPath), { recursive: true });
  await mkdir(dirname(service.stdoutPath), { recursive: true });
  await mkdir(dirname(service.stderrPath), { recursive: true });
}

async function hasPlist(service: ManagedServiceDefinition): Promise<boolean> {
  return access(service.plistPath)
    .then(() => true)
    .catch(() => false);
}

export async function installLaunchdService(
  service: ManagedServiceDefinition,
  runner: CommandRunner,
  platform = process.platform,
): Promise<ServiceActionResult> {
  if (!isLaunchdSupported(platform)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      status: createUnsupportedStatus(service),
    };
  }
  await ensureServiceDirectories(service);
  await writeFile(service.plistPath, renderLaunchdPlist(service));
  const bootout = await runner([
    "launchctl",
    "bootout",
    LAUNCHD_DOMAIN,
    service.plistPath,
  ]);
  const absent = isMissingServiceMessage(
    `${bootout.stdout}\n${bootout.stderr}`,
  );
  const bootstrap = await runner([
    "launchctl",
    "bootstrap",
    LAUNCHD_DOMAIN,
    service.plistPath,
  ]);
  if (bootstrap.exitCode !== 0) {
    return {
      ok: false,
      reason: "launchctl_failed",
      status: await getLaunchdServiceStatus(service, runner, platform),
      stdout: `${bootout.stdout}${absent ? "" : `\n${bootout.stdout}`}`,
      stderr: `${bootout.stderr}\n${bootstrap.stderr}`.trim(),
    };
  }
  const kickstart = await runner([
    "launchctl",
    "kickstart",
    "-k",
    `${LAUNCHD_DOMAIN}/${service.label}`,
  ]);
  return {
    ok: kickstart.exitCode === 0,
    reason: kickstart.exitCode === 0 ? "ok" : "launchctl_failed",
    status: await getLaunchdServiceStatus(service, runner, platform),
    stdout: kickstart.stdout,
    stderr: kickstart.stderr,
  };
}

export async function startLaunchdService(
  service: ManagedServiceDefinition,
  runner: CommandRunner,
  platform = process.platform,
): Promise<ServiceActionResult> {
  if (!isLaunchdSupported(platform)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      status: createUnsupportedStatus(service),
    };
  }
  if (!(await hasPlist(service))) {
    return {
      ok: false,
      reason: "missing_plist",
      status: createAbsentStatus(service),
    };
  }
  const status = await getLaunchdServiceStatus(service, runner, platform);
  if (status.installState === "absent") {
    const bootstrap = await runner([
      "launchctl",
      "bootstrap",
      LAUNCHD_DOMAIN,
      service.plistPath,
    ]);
    if (bootstrap.exitCode !== 0) {
      return {
        ok: false,
        reason: "launchctl_failed",
        status: await getLaunchdServiceStatus(service, runner, platform),
        stdout: bootstrap.stdout,
        stderr: bootstrap.stderr,
      };
    }
  }
  const out = await runner([
    "launchctl",
    "kickstart",
    "-k",
    `${LAUNCHD_DOMAIN}/${service.label}`,
  ]);
  return {
    ok: out.exitCode === 0,
    reason: out.exitCode === 0 ? "ok" : "launchctl_failed",
    status: await getLaunchdServiceStatus(service, runner, platform),
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

export async function stopLaunchdService(
  service: ManagedServiceDefinition,
  runner: CommandRunner,
  platform = process.platform,
): Promise<ServiceActionResult> {
  if (!isLaunchdSupported(platform)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      status: createUnsupportedStatus(service),
    };
  }
  const out = await runner([
    "launchctl",
    "bootout",
    `${LAUNCHD_DOMAIN}/${service.label}`,
  ]);
  const missing = isMissingServiceMessage(`${out.stdout}\n${out.stderr}`);
  return {
    ok: out.exitCode === 0 || missing,
    reason: out.exitCode === 0 || missing ? "ok" : "launchctl_failed",
    status: missing
      ? createAbsentStatus(service)
      : await getLaunchdServiceStatus(service, runner, platform),
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

export async function uninstallLaunchdService(
  service: ManagedServiceDefinition,
  runner: CommandRunner,
  platform = process.platform,
): Promise<ServiceActionResult> {
  if (!isLaunchdSupported(platform)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      status: createUnsupportedStatus(service),
    };
  }
  const stopped = await stopLaunchdService(service, runner, platform);
  await rm(service.plistPath, { force: true });
  return {
    ok: stopped.ok,
    reason: stopped.ok ? "ok" : stopped.reason,
    status: createAbsentStatus(service),
    stdout: stopped.stdout,
    stderr: stopped.stderr,
  };
}

export async function runCommand(argv: string[]): Promise<CommandOutput> {
  const proc = Bun.spawn({
    cmd: argv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function probeHttpUrl(
  url: string,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<boolean> {
  return fetcher(url, {
    method: "GET",
    signal: createTimeoutSignal(timeoutMs),
  })
    .then(() => true)
    .catch(() => false);
}

function parseLaunchctlList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.split(/\s+/);
      const label = parts.at(-1);
      if (!label || label === "Label") {
        return [];
      }
      return [label];
    });
}

export async function detectOpenCodeStatus(input: {
  config: Config;
  services: Record<ManagedServiceName, ManagedServiceDefinition>;
  runner?: CommandRunner;
  fetcher?: FetchLike;
  platform?: NodeJS.Platform;
}): Promise<OpenCodeDetectionStatus> {
  const runner = input.runner ?? runCommand;
  const fetcher = input.fetcher ?? fetch;
  const configuredUrl = input.config.opencodeServerUrl;
  const reachableConfigured = await probeHttpUrl(configuredUrl, fetcher, 1200);
  if (reachableConfigured) {
    return {
      state: "reachable_configured_url",
      recommendedAction: "reuse",
      configuredUrl,
      reachableUrl: configuredUrl,
      launchdLabel: null,
    };
  }

  if (isLaunchdSupported(input.platform)) {
    const list = await runner(["launchctl", "list"]);
    if (list.exitCode === 0) {
      const labels = parseLaunchctlList(list.stdout);
      const launchdLabel = labels.find(
        (label) =>
          label === input.services.opencode.label ||
          (label.includes("opencode") &&
            label !== input.services.webhook.label),
      );
      if (launchdLabel) {
        return {
          state: "launchd_service",
          recommendedAction: "reuse",
          configuredUrl,
          reachableUrl: null,
          launchdLabel,
        };
      }
    }
  }

  const fallbackUrl = DEFAULT_OPENCODE_SERVER_URL;
  const reachableListener = await probeHttpUrl(fallbackUrl, fetcher, 1200);
  if (reachableListener) {
    return {
      state: "listener",
      recommendedAction: "reuse",
      configuredUrl,
      reachableUrl: fallbackUrl,
      launchdLabel: null,
    };
  }

  return {
    state: "absent",
    recommendedAction: "offer_managed_service",
    configuredUrl,
    reachableUrl: null,
    launchdLabel: null,
  };
}

export function formatServiceStatus(status: ManagedServiceStatus): string {
  return [
    `${status.name}: ${status.installState}/${status.runtimeState}`,
    `label=${status.label}`,
    `pid=${status.pid ?? "-"}`,
    `exit=${status.lastExitStatus ?? "-"}`,
  ].join(" ");
}

export async function resolveOpencodeExecutablePath(): Promise<string | null> {
  const direct = await resolveExecutableFromPath("opencode");
  if (direct) {
    return direct;
  }
  const fallback = [
    join(homedir(), ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const candidate of fallback) {
    const ok = await access(candidate, fsConstants.X_OK)
      .then(() => true)
      .catch(() => false);
    if (ok) {
      return candidate;
    }
  }
  return null;
}
