import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";

const PathResultSchema = z.object({
  logPath: z.string(),
});

describe("createServerLogPath", () => {
  test("uses XDG data dir when set", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        [
          'import { createServerLogPath } from "./packages/server/src/config";',
          "process.stdout.write(JSON.stringify({",
          '  logPath: createServerLogPath(new Date("2026-03-06T21:57:17.187Z")),',
          "}));",
        ].join("\n"),
      ],
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: "/tmp/opencode-data",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const paths = PathResultSchema.parse(JSON.parse(stdout));
    expect(
      paths.logPath.startsWith("/tmp/opencode-data/opencode-linear-agent/"),
    ).toBe(true);
  });

  test("creates per-start server log path", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        [
          'import { createServerLogPath } from "./packages/server/src/config";',
          "process.stdout.write(JSON.stringify({",
          '  logPath: createServerLogPath(new Date("2026-03-06T21:57:17.187Z"), 3210),',
          "}));",
        ].join("\n"),
      ],
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: "/tmp/opencode-data",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const paths = PathResultSchema.parse(JSON.parse(stdout));
    expect(paths.logPath).toBe(
      join(
        "/tmp/opencode-data",
        "opencode-linear-agent",
        "log",
        "server-20260306T215717.187Z-p3210.log",
      ),
    );
  });

  test("resolves log dir from XDG data dir", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        [
          'import { getLogDir } from "./packages/server/src/config";',
          "process.stdout.write(JSON.stringify({ logDir: getLogDir() }));",
        ].join("\n"),
      ],
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: "/tmp/opencode-data",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      logDir: "/tmp/opencode-data/opencode-linear-agent/log",
    });
  });

  test("keeps per-start log filenames unique within same second", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        [
          'import { createServerLogPath } from "./packages/server/src/config";',
          'const now = new Date("2026-03-06T21:57:17.187Z");',
          "process.stdout.write(JSON.stringify({",
          "  a: createServerLogPath(now, 111),",
          "  b: createServerLogPath(now, 222),",
          "}));",
        ].join("\n"),
      ],
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: "/tmp/opencode-data",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const out: { a: string; b: string } = JSON.parse(stdout);
    expect(out.a).not.toBe(out.b);
    expect(out.a).toContain("server-20260306T215717.187Z-p111.log");
    expect(out.b).toContain("server-20260306T215717.187Z-p222.log");
  });
});
