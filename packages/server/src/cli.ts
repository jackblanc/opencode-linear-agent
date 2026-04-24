import { Log } from "@opencode-linear-agent/core";
import { Result } from "better-result";

import type { ServerRuntime } from "./index";

import { startServer, stopServer } from "./index";

const log = Log.create({ service: "startup" });

let runtime: ServerRuntime | null = null;
let stopping = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function shutdown(signal: string): void {
  if (stopping) {
    return;
  }
  stopping = true;

  log.info("Shutting down", { signal });
  if (!runtime) {
    process.exit(0);
  }

  void stopServer(runtime).then(
    () => {
      process.exit(0);
    },
    (error: unknown) => {
      log.error("Shutdown failed", {
        error: errorMessage(error),
        stack: errorStack(error),
      });
      process.exit(1);
    },
  );
}

const started = Result.try({
  try: () => startServer(),
  catch: (error: unknown) => error,
});
if (started.isErr()) {
  log.error("Failed to start server", {
    error: errorMessage(started.error),
    stack: errorStack(started.error),
  });
  process.exit(1);
}

runtime = started.value;
process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
