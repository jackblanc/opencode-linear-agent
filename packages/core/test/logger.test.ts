import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Log } from "../src/logger";

let dir = "";

afterEach(async () => {
  Log.init({ filePath: null, format: "pretty", level: "INFO" });
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("Log", () => {
  test("writes structured logs to optional file sink", async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-linear-agent-logger-"));
    const path = join(dir, "server.log");

    Log.init({ filePath: path, format: "json", level: "INFO" });
    Log.create({ service: "test" }).info("hello", { count: 1 });

    const text = await readFile(path, "utf8");

    expect(text).toContain('"service":"test"');
    expect(text).toContain('"message":"hello"');
    expect(text).toContain('"count":1');
  });
});
