import { dirname, join } from "node:path";
import { getStateRootPath } from "@opencode-linear-agent/core";

function getDataDir(): string {
  return dirname(getStateRootPath());
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
  return join(getDataDir(), "log");
}

export function createServerLogPath(
  now = new Date(),
  pid = process.pid,
): string {
  return join(getLogDir(), `server-${formatLogTimestamp(now)}-p${pid}.log`);
}
