import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  detectOpenCodeStatus,
  getLaunchdServiceStatus,
  installLaunchdService,
  uninstallLaunchdService,
  type CommandOutput,
  type ManagedServiceDefinition,
} from "../src/launchd";

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

const services: Record<"webhook" | "opencode", ManagedServiceDefinition> = {
  webhook: {
    name: "webhook",
    label: "com.opencode-linear-agent.server",
    plistPath:
      "/Users/test/Library/LaunchAgents/com.opencode-linear-agent.server.plist",
    stdoutPath: "/tmp/launchd.log",
    stderrPath: "/tmp/launchd.err",
    programArguments: ["/usr/local/bin/opencode-linear-agent", "serve"],
  },
  opencode: {
    name: "opencode",
    label: "com.opencode-linear-agent.opencode",
    plistPath:
      "/Users/test/Library/LaunchAgents/com.opencode-linear-agent.opencode.plist",
    stdoutPath: "/tmp/opencode.log",
    stderrPath: "/tmp/opencode.err",
    programArguments: [
      "/usr/local/bin/opencode",
      "serve",
      "--port",
      "4096",
      "--hostname",
      "127.0.0.1",
    ],
  },
};

const oldPath = process.env["PATH"];
const oldHome = process.env["HOME"];
const oldXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const oldXdgDataHome = process.env["XDG_DATA_HOME"];

beforeEach(() => {
  process.env["PATH"] = "/usr/local/bin:/usr/bin:/bin";
  process.env["HOME"] = "/Users/test";
  process.env["XDG_CONFIG_HOME"] = "/tmp/opencode-config";
  process.env["XDG_DATA_HOME"] = "/tmp/opencode-data";
});

afterEach(() => {
  if (oldPath) {
    process.env["PATH"] = oldPath;
  } else {
    delete process.env["PATH"];
  }
  if (oldXdgConfigHome) {
    process.env["XDG_CONFIG_HOME"] = oldXdgConfigHome;
  } else {
    delete process.env["XDG_CONFIG_HOME"];
  }
  if (oldHome) {
    process.env["HOME"] = oldHome;
  } else {
    delete process.env["HOME"];
  }
  if (oldXdgDataHome) {
    process.env["XDG_DATA_HOME"] = oldXdgDataHome;
  } else {
    delete process.env["XDG_DATA_HOME"];
  }
});

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

function createFetcher(
  okUrls: Array<string | { url: string; status: number }>,
): (input: string | URL) => Promise<Response> {
  return async (input: string | URL): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : input;
    const match = okUrls.find((item) =>
      typeof item === "string" ? item === url : item.url === url,
    );
    if (!match) {
      return Promise.reject(new Error("offline"));
    }
    return new Response("ok", {
      status: typeof match === "string" ? 200 : match.status,
    });
  };
}

describe("installLaunchdService", () => {
  test("renders direct program arguments and log paths", async () => {
    const plistPath = join(import.meta.dir, ".test-launchd", "opencode.plist");
    const service = {
      ...services.opencode,
      plistPath,
      stdoutPath: join(import.meta.dir, ".test-launchd", "opencode.log"),
      stderrPath: join(import.meta.dir, ".test-launchd", "opencode.err"),
    };
    const runner = createRunner({
      [`launchctl bootout gui/${process.getuid?.() ?? 0} ${plistPath}`]: {
        exitCode: 1,
        stdout: "",
        stderr: "Could not find service",
      },
      [`launchctl bootstrap gui/${process.getuid?.() ?? 0} ${plistPath}`]: {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
      [`launchctl kickstart -k gui/${process.getuid?.() ?? 0}/${service.label}`]:
        {
          exitCode: 0,
          stdout: "",
          stderr: "",
        },
      [`launchctl print gui/${process.getuid?.() ?? 0}/${service.label}`]: {
        exitCode: 0,
        stdout: "state = running\npid = 99\nlast exit code = 0\n",
        stderr: "",
      },
    });

    await installLaunchdService(service, runner, "darwin");
    const plist = await Bun.file(plistPath).text();

    expect(plist).toContain(
      "<string>com.opencode-linear-agent.opencode</string>",
    );
    expect(plist).toContain("<string>/usr/local/bin/opencode</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/tmp/opencode-config</string>");
    expect(plist).toContain("<string>/tmp/opencode-data</string>");
    expect(plist).toContain(`<string>${service.stderrPath}</string>`);
    expect(plist).not.toContain("/bin/sh");

    await rm(join(import.meta.dir, ".test-launchd"), {
      recursive: true,
      force: true,
    });
  });
});

describe("getLaunchdServiceStatus", () => {
  test("parses running state, pid, and exit code", async () => {
    const status = await getLaunchdServiceStatus(
      services.webhook,
      createRunner({
        [`launchctl print gui/${process.getuid?.() ?? 0}/${services.webhook.label}`]:
          {
            exitCode: 0,
            stdout: [
              "com.opencode-linear-agent.server = {",
              "  state = running",
              "  pid = 123",
              "  last exit code = 0",
              "}",
            ].join("\n"),
            stderr: "",
          },
      }),
      "darwin",
    );

    expect(status.installState).toBe("installed");
    expect(status.runtimeState).toBe("running");
    expect(status.pid).toBe(123);
    expect(status.lastExitStatus).toBe(0);
  });

  test("maps throttled state to stopped", async () => {
    const status = await getLaunchdServiceStatus(
      services.webhook,
      createRunner({
        [`launchctl print gui/${process.getuid?.() ?? 0}/${services.webhook.label}`]:
          {
            exitCode: 0,
            stdout: "state = throttled\npid = 123\nlast exit code = 78\n",
            stderr: "",
          },
      }),
      "darwin",
    );

    expect(status.runtimeState).toBe("stopped");
  });
});

describe("uninstallLaunchdService", () => {
  test("keeps plist when bootout fails", async () => {
    const plistPath = join(import.meta.dir, ".test-launchd", "webhook.plist");
    const service = {
      ...services.webhook,
      plistPath,
    };

    await Bun.write(plistPath, "plist");

    const result = await uninstallLaunchdService(
      service,
      createRunner({
        [`launchctl bootout gui/${process.getuid?.() ?? 0}/${service.label}`]: {
          exitCode: 5,
          stdout: "",
          stderr: "permission denied",
        },
        [`launchctl print gui/${process.getuid?.() ?? 0}/${service.label}`]: {
          exitCode: 0,
          stdout: "state = waiting\nlast exit code = 1\n",
          stderr: "",
        },
      }),
      "darwin",
    );

    expect(result.ok).toBe(false);
    expect(await Bun.file(plistPath).exists()).toBe(true);

    await rm(join(import.meta.dir, ".test-launchd"), {
      recursive: true,
      force: true,
    });
  });
});

describe("detectOpenCodeStatus", () => {
  test("prefers reachable configured URL", async () => {
    const status = await detectOpenCodeStatus({
      config,
      services,
      platform: "darwin",
      runner: createRunner({
        "launchctl list": { exitCode: 0, stdout: "", stderr: "" },
      }),
      fetcher: async () => new Response("ok", { status: 200 }),
    });

    expect(status.state).toBe("reachable_configured_url");
    expect(status.recommendedAction).toBe("reuse");
  });

  test("reuses launchd-managed OpenCode before port probe", async () => {
    const status = await detectOpenCodeStatus({
      config,
      services,
      platform: "darwin",
      runner: createRunner({
        "launchctl list": {
          exitCode: 0,
          stdout: "123\t0\tcom.opencode.server\n",
          stderr: "",
        },
        [`launchctl print gui/${process.getuid?.() ?? 0}/com.opencode.server`]:
          {
            exitCode: 0,
            stdout: "state = running\npid = 33\nlast exit code = 0\n",
            stderr: "",
          },
      }),
      fetcher: createFetcher(["http://127.0.0.1:4096"]),
    });

    expect(status.state).toBe("launchd_service");
    expect(status.launchdLabel).toBe("com.opencode.server");
  });

  test("reuses running launchd service on configured local port", async () => {
    const status = await detectOpenCodeStatus({
      config: {
        ...config,
        opencodeServerUrl: "http://localhost:4123",
      },
      services,
      platform: "darwin",
      runner: createRunner({
        "launchctl list": {
          exitCode: 0,
          stdout: "123\t0\tcom.opencode.server\n",
          stderr: "",
        },
        [`launchctl print gui/${process.getuid?.() ?? 0}/com.opencode.server`]:
          {
            exitCode: 0,
            stdout: "state = running\npid = 33\nlast exit code = 0\n",
            stderr: "",
          },
      }),
      fetcher: createFetcher([]),
    });

    expect(status.state).toBe("launchd_service");
    expect(status.recommendedAction).toBe("reuse");
    expect(status.reachableUrl).toBe(null);
  });

  test("preserves configured local port for running launchd service", async () => {
    const status = await detectOpenCodeStatus({
      config: {
        ...config,
        opencodeServerUrl: "http://localhost:4123",
      },
      services: {
        ...services,
        opencode: {
          ...services.opencode,
          programArguments: [
            "/usr/local/bin/opencode",
            "serve",
            "--port",
            "4123",
            "--hostname",
            "127.0.0.1",
          ],
        },
      },
      platform: "darwin",
      runner: createRunner({
        "launchctl list": {
          exitCode: 0,
          stdout: "123\t0\tcom.opencode.server\n",
          stderr: "",
        },
        [`launchctl print gui/${process.getuid?.() ?? 0}/com.opencode.server`]:
          {
            exitCode: 0,
            stdout: "state = running\npid = 33\nlast exit code = 0\n",
            stderr: "",
          },
      }),
      fetcher: createFetcher([]),
    });

    expect(status.state).toBe("launchd_service");
    expect(status.recommendedAction).toBe("reuse");
    expect(status.reachableUrl).toBe(null);
  });

  test("does not reuse stopped launchd OpenCode service", async () => {
    const status = await detectOpenCodeStatus({
      config,
      services,
      platform: "darwin",
      runner: createRunner({
        "launchctl list": {
          exitCode: 0,
          stdout: "123\t0\tcom.opencode.server\n",
          stderr: "",
        },
        [`launchctl print gui/${process.getuid?.() ?? 0}/com.opencode.server`]:
          {
            exitCode: 0,
            stdout: "state = waiting\nlast exit code = 1\n",
            stderr: "",
          },
      }),
      fetcher: createFetcher([]),
    });

    expect(status.state).toBe("absent");
    expect(status.recommendedAction).toBe("offer_managed_service");
    expect(status.launchdLabel).toBe("com.opencode.server");
  });

  test("ignores unrelated launchd labels containing opencode", async () => {
    const status = await detectOpenCodeStatus({
      config,
      services,
      platform: "darwin",
      runner: createRunner({
        "launchctl list": {
          exitCode: 0,
          stdout: "123\t0\tcom.example.opencode-helper\n",
          stderr: "",
        },
      }),
      fetcher: createFetcher([]),
    });

    expect(status.state).toBe("absent");
    expect(status.recommendedAction).toBe("offer_managed_service");
  });

  test("falls back to local listener when configured URL is absent", async () => {
    const status = await detectOpenCodeStatus({
      config,
      services,
      platform: "linux",
      runner: createRunner({}),
      fetcher: createFetcher(["http://127.0.0.1:4096"]),
    });

    expect(status.state).toBe("listener");
    expect(status.reachableUrl).toBe("http://127.0.0.1:4096");
  });

  test("reports config mismatch when only fallback listener is reachable", async () => {
    const status = await detectOpenCodeStatus({
      config: {
        ...config,
        opencodeServerUrl: "http://localhost:4123",
      },
      services,
      platform: "linux",
      runner: createRunner({}),
      fetcher: createFetcher(["http://127.0.0.1:4096"]),
    });

    expect(status.state).toBe("listener_config_mismatch");
    expect(status.recommendedAction).toBe("update_config");
    expect(status.reachableUrl).toBe("http://127.0.0.1:4096");
  });

  test("ignores non-ok HTTP responses", async () => {
    const status = await detectOpenCodeStatus({
      config,
      services,
      platform: "linux",
      runner: createRunner({}),
      fetcher: createFetcher([{ url: "http://localhost:4096", status: 503 }]),
    });

    expect(status.state).toBe("absent");
    expect(status.recommendedAction).toBe("offer_managed_service");
  });
});
