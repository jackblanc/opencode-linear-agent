/**
 * Centralized logging module with hybrid output format.
 *
 * Pretty format (dev): INFO  2024-01-10T12:00:00 +15ms service=webhook issue=CODE-123 Message
 * JSON format (prod):  {"level":"INFO","service":"webhook","issue":"CODE-123","issueId":"uuid","message":"Message"}
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogFormat = "pretty" | "json";

const levelPriority: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Keys that contain UUIDs - omitted from pretty format, included in JSON
const UUID_KEYS = new Set([
  "issueId",
  "sessionId",
  "organizationId",
  "linearSessionId",
  "opcodeSessionId",
]);

let currentLevel: LogLevel = "INFO";
let currentFormat: LogFormat = "pretty";
let lastLogTime = Date.now();

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[currentLevel];
}

function formatError(error: Error, depth = 0): string {
  const result = error.message;
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result;
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return formatError(value);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function buildPretty(
  level: LogLevel,
  message: string,
  tags: Record<string, unknown>,
  extra?: Record<string, unknown>,
): string {
  const allTags = { ...tags, ...extra };
  const prefix = Object.entries(allTags)
    .filter(
      ([key, value]) =>
        value !== undefined && value !== null && !UUID_KEYS.has(key),
    )
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");

  const now = new Date();
  const diff = now.getTime() - lastLogTime;
  lastLogTime = now.getTime();

  const timestamp = now.toISOString().split(".")[0];
  const levelPadded = level.padEnd(5);

  return [levelPadded, timestamp, `+${diff}ms`, prefix, message]
    .filter(Boolean)
    .join(" ");
}

function buildJson(
  level: LogLevel,
  message: string,
  tags: Record<string, unknown>,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    ...tags,
    ...extra,
    message,
  });
}

function write(output: string): void {
  process.stderr.write(output + "\n");
}

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  /** Add a persistent tag to this logger instance */
  tag(key: string, value: unknown): Logger;
  /** Create a child logger with inherited tags */
  clone(): Logger;
}

const loggers = new Map<string, Logger>();

export function createLogger(tags?: Record<string, unknown>): Logger {
  const loggerTags: Record<string, unknown> = { ...tags };

  const service = loggerTags["service"];
  if (service && typeof service === "string") {
    const cached = loggers.get(service);
    if (cached) return cached;
  }

  function log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!shouldLog(level)) return;

    const output =
      currentFormat === "pretty"
        ? buildPretty(level, message, loggerTags, extra)
        : buildJson(level, message, loggerTags, extra);

    write(output);
  }

  const logger: Logger = {
    debug(message: string, extra?: Record<string, unknown>) {
      log("DEBUG", message, extra);
    },
    info(message: string, extra?: Record<string, unknown>) {
      log("INFO", message, extra);
    },
    warn(message: string, extra?: Record<string, unknown>) {
      log("WARN", message, extra);
    },
    error(message: string, extra?: Record<string, unknown>) {
      log("ERROR", message, extra);
    },
    tag(key: string, value: unknown) {
      loggerTags[key] = value;
      return logger;
    },
    clone() {
      return createLogger({ ...loggerTags });
    },
  };

  if (service && typeof service === "string") {
    loggers.set(service, logger);
  }

  return logger;
}

function detectFormat(): LogFormat {
  // 1. Explicit env var
  const envFormat = process.env["LOG_FORMAT"];
  if (envFormat === "pretty" || envFormat === "json") {
    return envFormat;
  }

  // 2. Production defaults to JSON
  if (process.env["NODE_ENV"] === "production") {
    return "json";
  }

  // 3. Default to pretty (works in Docker, terminal, etc.)
  return "pretty";
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (
    upper === "DEBUG" ||
    upper === "INFO" ||
    upper === "WARN" ||
    upper === "ERROR"
  ) {
    return upper;
  }
  return undefined;
}

export interface LogInitOptions {
  level?: LogLevel;
  format?: LogFormat;
}

export function initLogger(options: LogInitOptions = {}): void {
  currentLevel =
    options.level ?? parseLevel(process.env["LOG_LEVEL"]) ?? "INFO";
  currentFormat = options.format ?? detectFormat();
}

// Default logger for simple usage
export const defaultLogger = createLogger({ service: "default" });

// Initialize with defaults on module load
initLogger();

/**
 * Log namespace for convenient access to logger creation.
 * Provides a familiar API: Log.create({ service: "name" })
 */
export const Log = {
  create: createLogger,
  init: initLogger,
  Default: defaultLogger,
} as const;
