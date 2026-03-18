import { describe, expect, mock, test } from "bun:test";

void mock.module("xdg-basedir", () => ({
  xdgConfig: "/tmp/config",
  xdgData: "/tmp/data",
}));

const { getConfigPath, getStateRootPath, getStorePath } =
  await import("../src/paths");

describe("getAppPaths", () => {
  test("builds config path from xdg config root", () => {
    expect(getConfigPath()).toBe(
      "/tmp/config/opencode-linear-agent/config.json",
    );
  });

  test("builds store path from xdg data root", () => {
    expect(getStorePath()).toBe("/tmp/data/opencode-linear-agent/store.json");
  });

  test("builds state root path from xdg data root", () => {
    expect(getStateRootPath()).toBe("/tmp/data/opencode-linear-agent/state");
  });
});
