import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/commands";
import type { CommandOutput } from "../src/launchd";

const config = {
  webhookServerPublicHostname: "example.com",
  webhookServerPort: 3210,
  opencodeServerUrl: "http://localhost:4096",
  linearClientId: "client",
  linearClientSecret: "secret",
  linearWebhookSecret: "webhook",
  linearWebhookIps: ["1.1.1.1"],
  projectsPath: "/tmp/projects",
};
const uid = process.getuid?.() ?? 0;
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");

function createBuffer(): {
  lines: string[];
  stream: { write(value: string): boolean };
} {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(value: string): boolean {
        lines.push(value);
        return true;
      },
    },
  };
}

function createRunner(
  outputs: Record<string, CommandOutput>,
): (argv: string[]) => Promise<CommandOutput> {
  return async (argv: string[]): Promise<CommandOutput> => {
    const key = argv.join(" ");
    return (
      outputs[key] ?? { exitCode: 1, stdout: "", stderr: `missing: ${key}` }
    );
  };
}

describe("runCli", () => {
  test("prints structured json status", async () => {
    const stdout = createBuffer();
    const code = await runCli(["status", "--json"], {
      startServer: async () => undefined,
      loadConfig: () => config,
      platform: "darwin",
      stdout: stdout.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => "/usr/local/bin/opencode",
      runner: createRunner({
        [`launchctl print gui/${uid}/com.opencode-linear-agent.server`]: {
          exitCode: 0,
          stdout: "state = running\npid = 11\nlast exit code = 0\n",
          stderr: "",
        },
        [`launchctl print gui/${uid}/com.opencode-linear-agent.opencode`]: {
          exitCode: 1,
          stdout: "",
          stderr: "Could not find service",
        },
      }),
      fetcher: async () => new Response("ok", { status: 200 }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.lines.join(""))).toMatchObject({
      launchdSupported: true,
      webhook: { runtimeState: "running" },
      opencode: { state: "configured_url_reachable" },
    });
  });

  test("setup installs managed OpenCode when configured URL is down", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    let probes = 0;

    const code = await runCli(["setup"], {
      startServer: async () => undefined,
      loadConfig: () => config,
      platform: "darwin",
      stdout: stdout.stream,
      stderr: stderr.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => "/usr/local/bin/opencode",
      runner: createRunner({
        [`launchctl bootout gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 1,
            stdout: "",
            stderr: "Could not find service",
          },
        [`launchctl bootstrap gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl kickstart -k gui/${uid}/com.opencode-linear-agent.server`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl print gui/${uid}/com.opencode-linear-agent.server`]: {
          exitCode: 0,
          stdout: "state = running\npid = 11\nlast exit code = 0\n",
          stderr: "",
        },
        [`launchctl bootout gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.opencode.plist")}`]:
          {
            exitCode: 1,
            stdout: "",
            stderr: "Could not find service",
          },
        [`launchctl bootstrap gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.opencode.plist")}`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl kickstart -k gui/${uid}/com.opencode-linear-agent.opencode`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl print gui/${uid}/com.opencode-linear-agent.opencode`]: {
          exitCode: 0,
          stdout: "state = running\npid = 22\nlast exit code = 0\n",
          stderr: "",
        },
      }),
      fetcher: async () => {
        probes += 1;
        return probes >= 2
          ? new Response("ok", { status: 200 })
          : Promise.reject(new Error("offline"));
      },
    });

    expect(code).toBe(0);
    expect(probes).toBe(2);
    expect(stdout.lines.join("")).toContain(
      "opencode: configured_url_reachable",
    );
    expect(stderr.lines.join("")).toBe("");
  });

  test("setup fails for non-local configured OpenCode URL", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();

    const code = await runCli(["setup"], {
      startServer: async () => undefined,
      loadConfig: () => ({
        ...config,
        opencodeServerUrl: "https://opencode.example.com",
      }),
      platform: "darwin",
      stdout: stdout.stream,
      stderr: stderr.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => "/usr/local/bin/opencode",
      runner: createRunner({
        [`launchctl bootout gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 1,
            stdout: "",
            stderr: "Could not find service",
          },
        [`launchctl bootstrap gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl kickstart -k gui/${uid}/com.opencode-linear-agent.server`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl print gui/${uid}/com.opencode-linear-agent.server`]: {
          exitCode: 0,
          stdout: "state = running\npid = 11\nlast exit code = 0\n",
          stderr: "",
        },
      }),
      fetcher: async () => Promise.reject(new Error("offline")),
    });

    expect(code).toBe(1);
    expect(stderr.lines.join("")).toContain(
      "Managed OpenCode setup requires local http://localhost:<port>",
    );
  });

  test("setup fails clearly when binary is missing", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();

    const code = await runCli(["setup"], {
      startServer: async () => undefined,
      loadConfig: () => config,
      platform: "darwin",
      stdout: stdout.stream,
      stderr: stderr.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => null,
      runner: createRunner({
        [`launchctl bootout gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 1,
            stdout: "",
            stderr: "Could not find service",
          },
        [`launchctl bootstrap gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl kickstart -k gui/${uid}/com.opencode-linear-agent.server`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl print gui/${uid}/com.opencode-linear-agent.server`]: {
          exitCode: 0,
          stdout: "state = running\npid = 11\nlast exit code = 0\n",
          stderr: "",
        },
      }),
      fetcher: async () => Promise.reject(new Error("offline")),
    });

    expect(code).toBe(1);
    expect(stderr.lines.join("")).toContain(
      "OpenCode binary not found in PATH; cannot install managed service",
    );
  });

  test("service status exits nonzero when absent", async () => {
    const stdout = createBuffer();

    const code = await runCli(["service", "status", "webhook"], {
      startServer: async () => undefined,
      loadConfig: () => config,
      platform: "darwin",
      stdout: stdout.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => "/usr/local/bin/opencode",
      runner: createRunner({
        [`launchctl print gui/${uid}/com.opencode-linear-agent.server`]: {
          exitCode: 1,
          stdout: "",
          stderr: "Could not find service",
        },
      }),
    });

    expect(code).toBe(1);
    expect(stdout.lines.join("")).toContain("webhook: absent/stopped");
  });

  test("service install supports json output", async () => {
    const stdout = createBuffer();

    const code = await runCli(["service", "install", "webhook", "--json"], {
      startServer: async () => undefined,
      loadConfig: () => config,
      platform: "darwin",
      stdout: stdout.stream,
      stderr: createBuffer().stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => "/usr/local/bin/opencode",
      runner: createRunner({
        [`launchctl bootout gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 1,
            stdout: "",
            stderr: "Could not find service",
          },
        [`launchctl bootstrap gui/${uid} ${join(launchAgentsDir, "com.opencode-linear-agent.server.plist")}`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl kickstart -k gui/${uid}/com.opencode-linear-agent.server`]:
          {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        [`launchctl print gui/${uid}/com.opencode-linear-agent.server`]: {
          exitCode: 0,
          stdout: "state = running\npid = 11\nlast exit code = 0\n",
          stderr: "",
        },
      }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.lines.join(""))).toMatchObject({
      ok: true,
      reason: "ok",
      status: { name: "webhook", runtimeState: "running" },
    });
  });

  test("service install opencode fails clearly when config is unsupported", async () => {
    const stderr = createBuffer();

    const code = await runCli(["service", "install", "opencode"], {
      startServer: async () => undefined,
      loadConfig: () => ({
        ...config,
        opencodeServerUrl: "https://opencode.example.com",
      }),
      platform: "darwin",
      stdout: createBuffer().stream,
      stderr: stderr.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => "/usr/local/bin/opencode",
      runner: createRunner({}),
    });

    expect(code).toBe(1);
    expect(stderr.lines.join("")).toContain(
      "Managed OpenCode setup requires local http://localhost:<port>",
    );
  });

  test("service start opencode fails clearly when binary is missing", async () => {
    const stderr = createBuffer();

    const code = await runCli(["service", "start", "opencode"], {
      startServer: async () => undefined,
      loadConfig: () => config,
      platform: "darwin",
      stdout: createBuffer().stream,
      stderr: stderr.stream,
      resolveAgentCommand: async () => ["/usr/local/bin/opencode-linear-agent"],
      resolveOpencodePath: async () => null,
      runner: createRunner({}),
    });

    expect(code).toBe(1);
    expect(stderr.lines.join("")).toContain(
      "OpenCode binary not found in PATH; cannot manage service",
    );
  });
});
