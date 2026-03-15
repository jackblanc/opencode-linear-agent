import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  getAppPaths,
  getManagedOpencodeHostAndPort,
  loadConfig,
} from "../src/config";

const TEST_DIR = join(import.meta.dir, ".test-config");
const ConfigResultSchema = z.object({
  projectsPath: z.string(),
  webhookServerPort: z.number(),
});
const PathResultSchema = z.object({
  logPath: z.string(),
});

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

const oldXdgDataHome = process.env["XDG_DATA_HOME"];

afterEach(async () => {
  if (oldXdgDataHome) {
    process.env["XDG_DATA_HOME"] = oldXdgDataHome;
  } else {
    delete process.env["XDG_DATA_HOME"];
  }
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("resolves tilde in projectsPath", async () => {
    const configDir = join(TEST_DIR, "config-home", "opencode-linear-agent");
    const configPath = join(configDir, "config.json");

    await mkdir(configDir, { recursive: true });
    await Bun.write(
      configPath,
      JSON.stringify({
        webhookServerPublicHostname: "example.com",
        webhookServerPort: 3210,
        opencodeServerUrl: "http://localhost:4096",
        linearClientId: "client",
        linearClientSecret: "secret",
        linearWebhookSecret: "webhook",
        projectsPath: "~/projects",
      }),
    );

    const config = loadConfig({ configPath });

    expect(config.projectsPath).toBe(resolve(homedir(), "projects"));
    expect(config.linearWebhookIps).toHaveLength(3);
  });

  test("loads config from default shared path", async () => {
    const configHome = join(TEST_DIR, "config-home");
    const configDir = join(configHome, "opencode-linear-agent");
    const configPath = join(configDir, "config.json");

    await mkdir(configDir, { recursive: true });
    await Bun.write(
      configPath,
      JSON.stringify({
        webhookServerPublicHostname: "example.com",
        linearClientId: "client",
        linearClientSecret: "secret",
        linearWebhookSecret: "webhook",
        projectsPath: "/tmp/projects",
      }),
    );

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        [
          'import { loadConfig } from "./packages/server/src/config";',
          "process.stdout.write(JSON.stringify(loadConfig()));",
        ].join("\n"),
      ],
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const config = ConfigResultSchema.parse(JSON.parse(stdout));

    expect(config.projectsPath).toBe("/tmp/projects");
    expect(config.webhookServerPort).toBe(3210);
  });

  test("loads explicit config path", async () => {
    const configDir = join(TEST_DIR, "config-root", "opencode-linear-agent");
    const configPath = join(configDir, "config.json");

    await mkdir(configDir, { recursive: true });
    await Bun.write(
      configPath,
      JSON.stringify({
        webhookServerPublicHostname: "example.com",
        linearClientId: "client",
        linearClientSecret: "secret",
        linearWebhookSecret: "webhook",
        projectsPath: "/tmp/projects",
      }),
    );

    const config = loadConfig({ configPath });

    expect(config.webhookServerPort).toBe(3210);
    expect(config.projectsPath).toBe("/tmp/projects");
  });

  test("returns canonical app paths", () => {
    const paths = getAppPaths();

    expect(
      paths.webhookServicePlistPath.endsWith(
        "/Library/LaunchAgents/com.opencode-linear-agent.server.plist",
      ),
    ).toBe(true);
    expect(
      paths.opencodeServicePlistPath.endsWith(
        "/Library/LaunchAgents/com.opencode-linear-agent.opencode.plist",
      ),
    ).toBe(true);
    expect(
      paths.webhookLogPath.endsWith("/opencode-linear-agent/launchd.log"),
    ).toBe(true);
    expect(
      paths.opencodeErrorLogPath.endsWith(
        "/opencode-linear-agent/opencode.launchd.err",
      ),
    ).toBe(true);
  });

  test("normalizes managed OpenCode host and port", () => {
    const local = getManagedOpencodeHostAndPort({
      webhookServerPublicHostname: "example.com",
      webhookServerPort: 3210,
      opencodeServerUrl: "http://localhost:4123",
      linearClientId: "client",
      linearClientSecret: "secret",
      linearWebhookSecret: "webhook",
      linearWebhookIps: ["1.1.1.1"],
      projectsPath: "/tmp/projects",
    });

    const remote = getManagedOpencodeHostAndPort({
      webhookServerPublicHostname: "example.com",
      webhookServerPort: 3210,
      opencodeServerUrl: "https://opencode.example.com",
      linearClientId: "client",
      linearClientSecret: "secret",
      linearWebhookSecret: "webhook",
      linearWebhookIps: ["1.1.1.1"],
      projectsPath: "/tmp/projects",
    });

    expect(local).toEqual({ hostname: "127.0.0.1", port: 4123 });
    expect(remote).toBe(null);
  });

  test("fails clearly when config file is missing", () => {
    const configPath = join(TEST_DIR, "missing.json");

    expect(() => loadConfig({ configPath })).toThrow(
      `Config file not found at ${configPath}. Please create a config file with the necessary configuration values.`,
    );
  });

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
});
