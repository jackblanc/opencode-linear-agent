import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Log, createFileLogSink } from "../src/logger";

let dir = "";
let lines: string[] = [];
let stderrWrite: typeof process.stderr.write;
let sink: Awaited<ReturnType<typeof createFileLogSink>> | null = null;

beforeEach(async () => {
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
  Log.init({ level: "INFO", sink: null });
});

afterEach(async () => {
  Object.defineProperty(process.stderr, "write", {
    configurable: true,
    value: stderrWrite,
    writable: true,
  });
  if (sink) {
    await sink.close();
    sink = null;
  }
  Log.init({ level: "INFO", sink: null });
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
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

    await Bun.sleep(10);
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

  test("server logging writes to file and stderr", async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-linear-agent-logger-"));
    const path = join(dir, "server.log");
    sink = await createFileLogSink(path);

    Log.init({ level: "INFO", sink });
    Log.create({ service: "server" }).info("hello", { count: 1 });
    await sink.flush();

    const text = await readFile(path, "utf8");

    expect(lines.join("")).toContain("service=server count=1 hello");
    expect(text).toContain("service=server count=1 hello");
  });
});
