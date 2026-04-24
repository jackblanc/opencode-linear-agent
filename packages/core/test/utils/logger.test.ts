import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Log } from "../../src/utils/logger";

let lines: string[] = [];
let stderrWrite: typeof process.stderr.write;

beforeEach(() => {
  lines = [];
  stderrWrite = process.stderr.write.bind(process.stderr);
  Object.defineProperty(process.stderr, "write", {
    configurable: true,
    value(chunk: string | Uint8Array): boolean {
      lines.push(String(chunk));
      return true;
    },
    writable: true,
  });
  Log.configure({ level: "INFO" });
});

afterEach(() => {
  Object.defineProperty(process.stderr, "write", {
    configurable: true,
    value: stderrWrite,
    writable: true,
  });
  Log.configure({ level: "INFO" });
  vi.restoreAllMocks();
});

describe("Log", () => {
  test("Log.create never shares state with another logger", () => {
    const a = Log.create({ service: "a" }).tag("request", "one");
    const b = Log.create({ service: "b" });

    a.info("first");
    b.info("second");

    expect(lines.join("")).toContain("service=a request=one first");
    expect(lines.join("")).toContain("service=b second");
    expect(lines.join("")).not.toContain("service=b request=one second");
  });

  test("tag returns child logger and does not mutate parent", () => {
    const base = Log.create({ service: "test" });
    const child = base.tag("request", "one");

    base.info("base");
    child.info("child");
    base.info("base again");

    const out = lines.join("");
    expect(out).toContain("service=test base\n");
    expect(out).toContain("service=test request=one child");
    expect(out).toContain("service=test base again");
    expect(out).not.toContain("service=test request=one base again");
  });

  test("time logs explicit operation timing", async () => {
    const stop = Log.create({ service: "timer" }).time("sync");

    await sleep(10);
    stop({ status: "ok" });

    const out = lines.join("");
    expect(out).toContain("service=timer operation=sync status=ok durationMs=");
    expect(out).toContain("completed");
    expect(out).toMatch(/durationMs=\d+/);
  });

  test("logging never throws on Error circular objects or BigInt", () => {
    const err = new Error("boom", { cause: new Error("root") });
    const circ: Record<string, unknown> = { name: "loop" };
    circ["self"] = circ;

    expect(() => {
      const log = Log.create({ service: "safe" });
      log.error("err", { err });
      log.info("circ", { circ });
      log.info("big", { value: BigInt(9) });
    }).not.toThrow();

    const out = lines.join("");
    expect(out).toContain("boom");
    expect(out).toContain("[Circular]");
    expect(out).toContain("9n");
  });

  test("level config filters lower priority logs", () => {
    Log.configure({ level: "WARN" });
    const log = Log.create({ service: "level" });

    log.info("hidden");
    log.warn("shown");

    const out = lines.join("");
    expect(out).not.toContain("hidden");
    expect(out).toContain("shown");
  });
});
