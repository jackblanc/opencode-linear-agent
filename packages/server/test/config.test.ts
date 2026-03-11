import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const TEST_DIR = join(import.meta.dir, ".test-config");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("loads config from shared default path", async () => {
    const home = join(TEST_DIR, "home");
    const configDir = join(home, ".config", "opencode-linear-agent");
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

    const config = loadConfig({ env: { HOME: home } });

    expect(config.projectsPath).toBe(join(home, "projects"));
    expect(config.linearWebhookIps).toHaveLength(3);
  });

  test("prefers XDG_CONFIG_HOME override", async () => {
    const configRoot = join(TEST_DIR, "config-root");
    const configDir = join(configRoot, "opencode-linear-agent");
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

    const config = loadConfig({
      env: {
        HOME: "/unused-home",
        XDG_CONFIG_HOME: configRoot,
      },
    });

    expect(config.webhookServerPort).toBe(3210);
    expect(config.projectsPath).toBe("/tmp/projects");
  });

  test("fails clearly when config root cannot resolve", () => {
    expect(() => loadConfig({ env: {} })).toThrow(
      "Failed to resolve XDG config path. Set HOME or XDG_CONFIG_HOME.",
    );
  });
});
