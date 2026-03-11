import { describe, expect, test } from "bun:test";
import { getAppPaths } from "../src/paths";

describe("getAppPaths", () => {
  test("uses HOME fallbacks for config data cache and state", () => {
    const paths = getAppPaths({ HOME: "/tmp/home" });

    expect(paths.configFile).toBe(
      "/tmp/home/.config/opencode-linear-agent/config.json",
    );
    expect(paths.dataDir).toBe("/tmp/home/.local/share/opencode-linear-agent");
    expect(paths.cacheDir).toBe("/tmp/home/.cache/opencode-linear-agent");
    expect(paths.storeFile).toBe(
      "/tmp/home/.local/share/opencode-linear-agent/store.json",
    );
    expect(paths.runtimeDir).toBe(
      "/tmp/home/.local/state/opencode-linear-agent/runtime",
    );
    expect(paths.launchdLogFile).toBe(
      "/tmp/home/.local/share/opencode-linear-agent/launchd.log",
    );
    expect(paths.launchdErrFile).toBe(
      "/tmp/home/.local/share/opencode-linear-agent/launchd.err",
    );
    expect(paths.opencodePluginFile).toBe(
      "/tmp/home/.config/opencode/plugin/linear.js",
    );
  });

  test("uses explicit XDG overrides", () => {
    const paths = getAppPaths({
      HOME: "/tmp/home",
      XDG_CACHE_HOME: "/tmp/cache",
      XDG_CONFIG_HOME: "/tmp/config",
      XDG_DATA_HOME: "/tmp/data",
      XDG_RUNTIME_DIR: "/tmp/runtime",
      XDG_STATE_HOME: "/tmp/state",
    });

    expect(paths.configDir).toBe("/tmp/config/opencode-linear-agent");
    expect(paths.dataDir).toBe("/tmp/data/opencode-linear-agent");
    expect(paths.cacheDir).toBe("/tmp/cache/opencode-linear-agent");
    expect(paths.stateDir).toBe("/tmp/state/opencode-linear-agent");
    expect(paths.runtimeDir).toBe("/tmp/runtime/opencode-linear-agent");
    expect(paths.configFile).toBe(
      "/tmp/config/opencode-linear-agent/config.json",
    );
    expect(paths.storeFile).toBe("/tmp/data/opencode-linear-agent/store.json");
    expect(paths.launchdLogFile).toBe(
      "/tmp/data/opencode-linear-agent/launchd.log",
    );
    expect(paths.launchdErrFile).toBe(
      "/tmp/data/opencode-linear-agent/launchd.err",
    );
    expect(paths.opencodeConfigDir).toBe("/tmp/config/opencode");
    expect(paths.opencodePluginDir).toBe("/tmp/config/opencode/plugin");
    expect(paths.opencodePluginFile).toBe(
      "/tmp/config/opencode/plugin/linear.js",
    );
  });

  test("throws when config root cannot resolve", () => {
    expect(() => getAppPaths({}).configFile).toThrow(
      "Failed to resolve XDG config path. Set HOME or XDG_CONFIG_HOME.",
    );
  });
});
