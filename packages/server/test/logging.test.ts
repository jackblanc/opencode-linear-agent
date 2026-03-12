import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const dirs: string[] = [];

async function run(
  code: string,
  dataHome: string,
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

describe("server logging", () => {
  test("log dir resolves from XDG data dir", async () => {
    const dataHome = await createDataHome();
    const result = await run(
      [
        'import { getLogDir } from "./packages/server/src/config";',
        "process.stdout.write(JSON.stringify({ logDir: getLogDir() }));",
      ].join("\n"),
      dataHome,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      logDir: join(dataHome, "opencode-linear-agent", "log"),
    });
  });

  test("per-start log filenames are unique within same second", async () => {
    const dataHome = await createDataHome();
    const result = await run(
      [
        'import { createServerLogPath } from "./packages/server/src/config";',
        'const now = new Date("2026-03-06T21:57:17.187Z");',
        "process.stdout.write(JSON.stringify({",
        "  a: createServerLogPath(now, 111),",
        "  b: createServerLogPath(now, 222),",
        "}));",
      ].join("\n"),
      dataHome,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const out: { a: string; b: string } = JSON.parse(result.stdout);
    expect(out.a).not.toBe(out.b);
    expect(out.a).toContain("server-20260306T215717.187Z-p111.log");
    expect(out.b).toContain("server-20260306T215717.187Z-p222.log");
  });

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
});
