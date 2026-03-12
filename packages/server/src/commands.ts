import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config";
import {
  detectOpenCodeStatus,
  formatServiceStatus,
  getLaunchdServiceStatus,
  getManagedServiceDefinitions,
  installLaunchdService,
  isLaunchdSupported,
  resolveAgentExecutableCommand,
  resolveOpencodeExecutablePath,
  runCommand,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService,
  type CommandRunner,
  type FetchLike,
  type ManagedServiceDefinition,
  type ManagedServiceName,
  type ManagedServiceStatus,
  type OpenCodeDetectionStatus,
} from "./launchd";

type Output = Pick<NodeJS.WriteStream, "write">;

export interface CliDeps {
  startServer(): Promise<unknown>;
  loadConfig(): Config;
  runner?: CommandRunner;
  fetcher?: FetchLike;
  stdout?: Output;
  stderr?: Output;
  platform?: NodeJS.Platform;
  resolveAgentCommand?: () => Promise<string[]>;
  resolveOpencodePath?: () => Promise<string | null>;
}

interface CliEnvironment {
  config: Config;
  services: Record<ManagedServiceName, ManagedServiceDefinition>;
}

interface StatusReport {
  platform: NodeJS.Platform;
  launchdSupported: boolean;
  webhook: ManagedServiceStatus;
  managedOpencode: ManagedServiceStatus;
  opencode: OpenCodeDetectionStatus;
}

function writeLine(stream: Output, line: string): void {
  stream.write(`${line}\n`);
}

function getFallbackOpencodePath(): string {
  return join(homedir(), ".local", "bin", "opencode");
}

async function createEnvironment(deps: CliDeps): Promise<CliEnvironment> {
  const config = deps.loadConfig();
  const agentCommand = await (
    deps.resolveAgentCommand ?? resolveAgentExecutableCommand
  )();
  const opencodePath = await (
    deps.resolveOpencodePath ?? resolveOpencodeExecutablePath
  )();
  return {
    config,
    services: getManagedServiceDefinitions({
      config,
      agentExecutableCommand: agentCommand,
      opencodeExecutablePath: opencodePath ?? getFallbackOpencodePath(),
    }),
  };
}

async function createStatusReport(deps: CliDeps): Promise<StatusReport> {
  const env = await createEnvironment(deps);
  const runner = deps.runner ?? runCommand;
  const fetcher = deps.fetcher ?? fetch;
  const platform = deps.platform ?? process.platform;
  const webhook = await getLaunchdServiceStatus(
    env.services.webhook,
    runner,
    platform,
  );
  const managedOpencode = await getLaunchdServiceStatus(
    env.services.opencode,
    runner,
    platform,
  );
  const opencode = await detectOpenCodeStatus({
    config: env.config,
    services: env.services,
    runner,
    fetcher,
    platform,
  });
  return {
    platform,
    launchdSupported: isLaunchdSupported(platform),
    webhook,
    managedOpencode,
    opencode,
  };
}

function formatOpenCodeDetection(status: OpenCodeDetectionStatus): string {
  return [
    `opencode: ${status.state}`,
    `action=${status.recommendedAction}`,
    `url=${status.reachableUrl ?? status.configuredUrl}`,
    `label=${status.launchdLabel ?? "-"}`,
  ].join(" ");
}

function printStatusText(report: StatusReport, stdout: Output): void {
  writeLine(stdout, `platform: ${report.platform}`);
  writeLine(
    stdout,
    `launchd: ${report.launchdSupported ? "supported" : "unsupported"}`,
  );
  writeLine(stdout, formatServiceStatus(report.webhook));
  writeLine(stdout, formatServiceStatus(report.managedOpencode));
  writeLine(stdout, formatOpenCodeDetection(report.opencode));
}

function printHelp(stdout: Output): void {
  writeLine(
    stdout,
    "Usage: opencode-linear-agent [serve|setup|status|service]",
  );
  writeLine(stdout, "  serve                          Start webhook server");
  writeLine(
    stdout,
    "  setup [--manage-opencode]      Install/start launchd services on macOS",
  );
  writeLine(
    stdout,
    "  status [--json]                Print service + OpenCode status",
  );
  writeLine(
    stdout,
    "  service <action> <name>        install|start|stop|uninstall|status webhook|opencode",
  );
}

function isJsonFlag(args: string[]): boolean {
  return args.includes("--json");
}

function isManageOpencodeFlag(args: string[]): boolean {
  return args.includes("--manage-opencode");
}

function getServiceName(value: string | undefined): ManagedServiceName | null {
  if (value === "webhook" || value === "opencode") {
    return value;
  }
  return null;
}

async function handleStatus(args: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const report = await createStatusReport(deps);
  if (isJsonFlag(args)) {
    writeLine(stdout, JSON.stringify(report, null, 2));
    return 0;
  }
  printStatusText(report, stdout);
  return 0;
}

async function handleSetup(args: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const platform = deps.platform ?? process.platform;
  if (!isLaunchdSupported(platform)) {
    writeLine(stderr, "launchd setup only supports macOS");
    return 1;
  }
  const env = await createEnvironment(deps);
  const runner = deps.runner ?? runCommand;
  const opencodePath = await (
    deps.resolveOpencodePath ?? resolveOpencodeExecutablePath
  )();
  const webhook = await installLaunchdService(
    env.services.webhook,
    runner,
    platform,
  );
  const detection = await detectOpenCodeStatus({
    config: env.config,
    services: env.services,
    runner,
    fetcher: deps.fetcher ?? fetch,
    platform,
  });

  let opencodeResultText = formatOpenCodeDetection(detection);
  let code = webhook.ok ? 0 : 1;
  if (detection.recommendedAction === "offer_managed_service") {
    if (isManageOpencodeFlag(args)) {
      if (!opencodePath) {
        writeLine(
          stderr,
          "OpenCode binary not found in PATH; cannot install managed service",
        );
        code = 1;
      } else {
        const managed = await installLaunchdService(
          env.services.opencode,
          runner,
          platform,
        );
        opencodeResultText = formatServiceStatus(managed.status);
        if (!managed.ok) {
          code = 1;
        }
      }
    } else {
      opencodeResultText = `${opencodeResultText} next=run 'opencode-linear-agent setup --manage-opencode' or start OpenCode manually`;
    }
  }

  writeLine(stdout, formatServiceStatus(webhook.status));
  writeLine(stdout, opencodeResultText);
  return code;
}

async function handleService(args: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const action = args[0];
  const name = getServiceName(args[1]);
  if (!action || !name) {
    printHelp(stderr);
    return 1;
  }
  const env = await createEnvironment(deps);
  const service = env.services[name];
  const runner = deps.runner ?? runCommand;
  const platform = deps.platform ?? process.platform;
  if (action === "status") {
    const status = await getLaunchdServiceStatus(service, runner, platform);
    if (isJsonFlag(args)) {
      writeLine(stdout, JSON.stringify(status, null, 2));
    } else {
      writeLine(stdout, formatServiceStatus(status));
    }
    return status.installState === "unsupported" ? 1 : 0;
  }
  const result =
    action === "install"
      ? await installLaunchdService(service, runner, platform)
      : action === "start"
        ? await startLaunchdService(service, runner, platform)
        : action === "stop"
          ? await stopLaunchdService(service, runner, platform)
          : action === "uninstall"
            ? await uninstallLaunchdService(service, runner, platform)
            : null;
  if (!result) {
    printHelp(stderr);
    return 1;
  }
  writeLine(stdout, formatServiceStatus(result.status));
  if (result.stderr) {
    writeLine(stderr, result.stderr.trim());
  }
  return result.ok ? 0 : 1;
}

export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const command = args[0] ?? "serve";
  if (command === "serve") {
    await deps.startServer();
    return 0;
  }
  if (command === "setup") {
    return handleSetup(args.slice(1), deps);
  }
  if (command === "status") {
    return handleStatus(args.slice(1), deps);
  }
  if (command === "service") {
    return handleService(args.slice(1), deps);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(stdout);
    return 0;
  }
  printHelp(deps.stderr ?? process.stderr);
  return 1;
}
