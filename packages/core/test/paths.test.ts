import { describe, expect, test } from "bun:test";
import { getConfigPath, getStorePath } from "../src/paths";

describe("getAppPaths", () => {
  test("builds app paths from explicit roots", () => {
    const options = {
      configHome: "/tmp/config",
      dataHome: "/tmp/data",
    };

    expect(getConfigPath(options)).toBe(
      "/tmp/config/opencode-linear-agent/config.json",
    );
    expect(getStorePath(options)).toBe(
      "/tmp/data/opencode-linear-agent/store.json",
    );
  });

  test("allows partial overrides", () => {
    expect(getConfigPath({ configHome: "/tmp/config" })).toBe(
      "/tmp/config/opencode-linear-agent/config.json",
    );
    expect(getStorePath({ dataHome: "/tmp/data" })).toBe(
      "/tmp/data/opencode-linear-agent/store.json",
    );
  });
});
