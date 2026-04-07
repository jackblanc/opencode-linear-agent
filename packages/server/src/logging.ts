import type { LogSink } from "@opencode-linear-agent/core";

import { createFileLogSink, getStateRootDirectoryPath, Log } from "@opencode-linear-agent/core";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

function getDataDir(): string {
  return dirname(getStateRootDirectoryPath());
}

function formatLogTimestamp(now: Date): string {
  const [head, tail] = now.toISOString().split(".");
  const ms = tail?.slice(0, 3);
  if (!head || !ms) {
    return "unknown";
  }
  return `${head.replaceAll("-", "").replaceAll(":", "")}.${ms}Z`;
}

function getLogDir(): string {
  return join(getDataDir(), "log");
}

function createServerLogPath(now = new Date(), pid = process.pid): string {
  return join(getLogDir(), `server-${formatLogTimestamp(now)}-p${pid}.log`);
}

interface ServerLoggingRuntime {
  log: ReturnType<typeof Log.create>;
  logPath: string;
  sink: LogSink;
}

let serverLoggingRuntime: ServerLoggingRuntime | null = null;
let serverLoggingRuntimePromise: Promise<ServerLoggingRuntime> | null = null;

async function createServerLoggingRuntime(): Promise<ServerLoggingRuntime> {
  const logDir = getLogDir();
  const logPath = createServerLogPath();

  await mkdir(logDir, { recursive: true });

  const sink = await createFileLogSink(logPath);
  Log.init({ sink });

  const runtime = {
    log: Log.create({ service: "startup" }),
    logPath,
    sink,
  } satisfies ServerLoggingRuntime;

  serverLoggingRuntime = runtime;
  return runtime;
}

export async function initializeServerLogging(): Promise<ServerLoggingRuntime> {
  if (serverLoggingRuntime) {
    return serverLoggingRuntime;
  }

  serverLoggingRuntimePromise ??= createServerLoggingRuntime().catch(async (error: unknown) => {
    serverLoggingRuntimePromise = null;
    throw error;
  });

  return serverLoggingRuntimePromise;
}

async function shutdownServerLogging(logging: ServerLoggingRuntime, signal: string): Promise<void> {
  logging.log.info("Shutting down", { signal });
  await Log.shutdown();
}

export function registerShutdownHandlers(
  server: ReturnType<typeof Bun.serve>,
  logging: ServerLoggingRuntime,
): void {
  let shutdown: Promise<void> | null = null;

  const run = (signal: string): void => {
    shutdown ??= shutdownServerLogging(logging, signal).then(
      () => {
        void server.stop(true);
        process.exit(0);
      },
      (error: unknown) => {
        void server.stop(true);
        process.stderr.write(
          `shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", () => run("SIGINT"));
  process.once("SIGTERM", () => run("SIGTERM"));
}
