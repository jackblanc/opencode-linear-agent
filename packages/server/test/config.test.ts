import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

  test("fails clearly when config file is missing", () => {
    const configPath = join(TEST_DIR, "missing.json");

    expect(() => loadConfig({ configPath })).toThrow(
      `Config file not found at ${configPath}. Please create a config file with the necessary configuration values.`,
    );
  });
});
