import { describe, expect, mock, test } from "bun:test";

void mock.module("xdg-basedir", () => ({
  xdgConfig: "/tmp/config",
  xdgData: "/tmp/data",
}));

const { getConfigPath, getStateRootPath } = await import("../src/utils/paths");

describe("getAppPaths", () => {
  test("builds config path from xdg config root", () => {
    expect(getConfigPath()).toBe(
      "/tmp/config/opencode-linear-agent/config.json",
    );
  });

  test("builds state root path from xdg data root", () => {
    expect(getStateRootPath()).toBe("/tmp/data/opencode-linear-agent/state");
  });
});
