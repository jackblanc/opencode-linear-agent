import { createWriteStream, type WriteStream } from "node:fs";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const levelPriority: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const UUID_KEYS = new Set([
  "issueId",
  "sessionId",
  "organizationId",
  "linearSessionId",
  "opencodeSessionId",
]);

export interface LogSink {
  write(line: string): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

type Runtime = Readonly<{
  level: LogLevel;
  sink: LogSink | null;
}>;

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  tag(key: string, value: unknown): Logger;
  time(
    operation: string,
    extra?: Record<string, unknown>,
  ): (extra?: Record<string, unknown>) => void;
}

interface LogInitOptions {
  level?: LogLevel;
  sink?: LogSink | null;
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (!value) {
    return undefined;
  }

  const upper = value.toUpperCase();
  switch (upper) {
    case "DEBUG":
    case "INFO":
    case "WARN":
    case "ERROR":
      return upper;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createRuntime(options: LogInitOptions = {}): Runtime {
  return {
    level: options.level ?? parseLevel(process.env["LOG_LEVEL"]) ?? "INFO",
    sink: options.sink ?? null,
  };
}

let runtime = createRuntime();

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[runtime.level];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function formatError(value: Error, seen: WeakSet<object>): string {
  seen.add(value);

  const parts = [`${value.name}: ${value.message}`];
  if (typeof value.stack === "string" && value.stack.length > 0) {
    parts.push(value.stack);
  }

  const cause = value.cause;
  if (cause instanceof Error && !seen.has(cause)) {
    parts.push(`cause=${formatError(cause, seen)}`);
  } else if (cause !== undefined) {
    parts.push(`cause=${formatValue(cause, seen)}`);
  }

  return quote(parts.join(" | "));
}

function formatArray(value: unknown[], seen: WeakSet<object>): string {
  const items: string[] = [];
  for (const item of value) {
    items.push(formatValue(item, seen));
  }
  return `[${items.join(",")}]`;
}

function formatObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
): string {
  const items: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }
    items.push(`${quote(key)}:${formatValue(item, seen)}`);
  }
  return `{${items.join(",")}}`;
}

function formatValue(value: unknown, seen = new WeakSet<object>()): string {
  switch (typeof value) {
    case "string":
      return /\s/.test(value) ? quote(value) : value;
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "undefined":
      return "undefined";
    case "symbol":
      return quote(String(value));
    case "function":
      return quote(`[Function ${value.name || "anonymous"}]`);
    case "object": {
      if (value === null) {
        return "null";
      }

      if (value instanceof Error) {
        return formatError(value, seen);
      }

      if (value instanceof Date) {
        return quote(value.toISOString());
      }

      if (seen.has(value)) {
        return quote("[Circular]");
      }

      seen.add(value);
      if (Array.isArray(value)) {
        return formatArray(value, seen);
      }

      return formatObject(isRecord(value) ? value : {}, seen);
    }
  }
}

function buildPretty(
  level: LogLevel,
  message: string,
  tags: Record<string, unknown>,
  extra?: Record<string, unknown>,
): string {
  const fields = { ...tags, ...extra };
  const prefix = Object.entries(fields)
    .filter(
      ([key, value]) =>
        value !== undefined && value !== null && !UUID_KEYS.has(key),
    )
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");

  return [level.padEnd(5), new Date().toISOString(), prefix, message]
    .filter(Boolean)
    .join(" ");
}

function write(line: string): void {
  const text = `${line}\n`;
  process.stderr.write(text);
  runtime.sink?.write(text);
}

function createLogger(tags: Record<string, unknown> = {}): Logger {
  function log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!shouldLog(level)) {
      return;
    }

    write(buildPretty(level, message, tags, extra));
  }

  return {
    debug(message: string, extra?: Record<string, unknown>): void {
      log("DEBUG", message, extra);
    },
    info(message: string, extra?: Record<string, unknown>): void {
      log("INFO", message, extra);
    },
    warn(message: string, extra?: Record<string, unknown>): void {
      log("WARN", message, extra);
    },
    error(message: string, extra?: Record<string, unknown>): void {
      log("ERROR", message, extra);
    },
    tag(key: string, value: unknown): Logger {
      return createLogger({ ...tags, [key]: value });
    },
    time(
      operation: string,
      extra: Record<string, unknown> = {},
    ): (extra?: Record<string, unknown>) => void {
      const start = performance.now();
      const child = createLogger({ ...tags, ...extra, operation });

      return (doneExtra: Record<string, unknown> = {}): void => {
        child.info("completed", {
          ...doneExtra,
          durationMs: Math.round(performance.now() - start),
        });
      };
    },
  };
}

function initLogger(options: LogInitOptions = {}): void {
  const sink = options.sink === undefined ? runtime.sink : options.sink;
  const oldSink = sink !== runtime.sink ? runtime.sink : null;

  runtime = createRuntime({
    level: options.level ?? runtime.level,
    sink,
  });

  if (oldSink) {
    void oldSink.close().then(
      () => undefined,
      () => undefined,
    );
  }
}

async function flushRuntime(): Promise<void> {
  return runtime.sink?.flush() ?? Promise.resolve();
}

async function shutdownRuntime(): Promise<void> {
  const sink = runtime.sink;

  runtime = createRuntime({
    level: runtime.level,
    sink: null,
  });

  await sink?.flush();
  await sink?.close();
}

async function waitForOpen(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const open = (): void => {
      stream.off("error", fail);
      resolve();
    };

    const fail = (error: Error): void => {
      stream.off("open", open);
      reject(error);
    };

    stream.once("open", open);
    stream.once("error", fail);
  });
}

export async function createFileLogSink(path: string): Promise<LogSink> {
  const stream = createWriteStream(path, { flags: "ax" });
  await waitForOpen(stream);

  let broken = false;
  stream.on("error", () => {
    broken = true;
  });

  return {
    write(line: string): void {
      if (!broken) {
        stream.write(line);
      }
    },
    async flush(): Promise<void> {
      if (broken) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        stream.write("", () => resolve());
      });
    },
    async close(): Promise<void> {
      if (broken) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}

const defaultLogger = createLogger({ service: "default" });

export const Log = {
  create: createLogger,
  init: initLogger,
  flush: flushRuntime,
  shutdown: shutdownRuntime,
  Default: defaultLogger,
} as const;
