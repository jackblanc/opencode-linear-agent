import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const dirs: string[] = [];

async function run(
  code: string,
  dataHome: string,
  extraEnv: Record<string, string> = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn({
    cmd: ["bun", "-e", code],
    cwd: ROOT,
    env: {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function createDataHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-linear-agent-data-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("server index", () => {
  test("startup initializes logging once and creates the log sink", async () => {
    const dataHome = await createDataHome();
    const result = await run(
      [
        'import { readFile } from "node:fs/promises";',
        'import { getLogDir } from "./packages/server/src/config";',
        'import { initializeServerLogging } from "./packages/server/src/index";',
        "const first = await initializeServerLogging();",
        "const second = await initializeServerLogging();",
        'first.log.info("boot", { ok: true });',
        "await first.sink.flush();",
        'const text = await readFile(first.logPath, "utf8");',
        "process.stdout.write(JSON.stringify({",
        "  logDir: getLogDir(),",
        "  firstPath: first.logPath,",
        "  secondPath: second.logPath,",
        "  text,",
        "}));",
      ].join("\n"),
      dataHome,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("service=startup ok=true boot");

    const out: {
      logDir: string;
      firstPath: string;
      secondPath: string;
      text: string;
    } = JSON.parse(result.stdout);

    expect(out.logDir).toBe(join(dataHome, "opencode-linear-agent", "log"));
    expect(out.firstPath).toBe(out.secondPath);
    expect(out.firstPath.startsWith(out.logDir)).toBe(true);
    expect(out.text).toContain("service=startup ok=true boot");
  });

  test("concurrent startup initialization shares one runtime", async () => {
    const dataHome = await createDataHome();
    const result = await run(
      [
        'import { initializeServerLogging } from "./packages/server/src/index";',
        "const [a, b] = await Promise.all([initializeServerLogging(), initializeServerLogging()]);",
        "process.stdout.write(JSON.stringify({",
        "  sameObject: a === b,",
        "  samePath: a.logPath === b.logPath,",
        "}));",
      ].join("\n"),
      dataHome,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    expect(JSON.parse(result.stdout)).toEqual({
      sameObject: true,
      samePath: true,
    });
  });

  test("shutdown flushes and closes the log sink", async () => {
    const dataHome = await createDataHome();
    const result = await run(
      [
        'import { readFile } from "node:fs/promises";',
        'import { Log } from "./packages/core/src/utils/logger";',
        'import { initializeServerLogging, shutdownServerLogging } from "./packages/server/src/index";',
        "const logging = await initializeServerLogging();",
        'logging.log.info("before shutdown", { ok: true });',
        'await shutdownServerLogging(logging, "SIGTERM");',
        'Log.create({ service: "startup" }).info("after shutdown", { ok: false });',
        'const text = await readFile(logging.logPath, "utf8");',
        "process.stdout.write(JSON.stringify({ text }));",
      ].join("\n"),
      dataHome,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("service=startup ok=true before shutdown");
    expect(result.stderr).toContain(
      "service=startup signal=SIGTERM Shutting down",
    );

    const out: { text: string } = JSON.parse(result.stdout);
    expect(out.text).toContain("service=startup ok=true before shutdown");
    expect(out.text).toContain("service=startup signal=SIGTERM Shutting down");
    expect(out.text).not.toContain("after shutdown");
  });

  test("startup failure flushes fatal log to file", async () => {
    const dataHome = await createDataHome();
    const configHome = await createDataHome();
    const proc = Bun.spawn({
      cmd: ["bun", "packages/server/src/index.ts"],
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Failed to start server");

    const logDir = join(dataHome, "opencode-linear-agent", "log");
    const files = await readdir(logDir);
    expect(files).toHaveLength(1);

    const text = await readFile(join(logDir, files[0] ?? ""), "utf8");
    expect(text).toContain("Starting Linear OpenCode Agent (Local)");
    expect(text).toContain("Failed to start server");
    expect(text).toContain("Config file not found");
  });
});
