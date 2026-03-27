import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const dirs: string[] = [];

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
