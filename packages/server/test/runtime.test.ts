import { describe, expect, test } from "bun:test";
import { getCacheName, RUNTIMES } from "../src/runtime";

describe("RUNTIMES", () => {
  test("includes darwin arm64 runtime", () => {
    expect(
      RUNTIMES.find(
        (runtime) => runtime.platform === "darwin" && runtime.arch === "arm64",
      ),
    ).toEqual({
      platform: "darwin",
      arch: "arm64",
      packageName: "@opencode-linear-agent/server-darwin-arm64",
      artifact: "opencode-linear-agent-darwin-arm64",
    });
  });

  test("includes darwin x64 runtime", () => {
    expect(
      RUNTIMES.find(
        (runtime) => runtime.platform === "darwin" && runtime.arch === "x64",
      ),
    ).toEqual({
      platform: "darwin",
      arch: "x64",
      packageName: "@opencode-linear-agent/server-darwin-x64",
      artifact: "opencode-linear-agent-darwin-x64",
    });
  });

  test("includes linux x64 runtime", () => {
    expect(
      RUNTIMES.find(
        (runtime) => runtime.platform === "linux" && runtime.arch === "x64",
      ),
    ).toEqual({
      platform: "linux",
      arch: "x64",
      packageName: "@opencode-linear-agent/server-linux-x64",
      artifact: "opencode-linear-agent-linux-x64",
    });
  });

  test("includes only supported runtimes", () => {
    expect(RUNTIMES).toHaveLength(4);
  });
});

describe("getCacheName", () => {
  test("uses platform specific cache file", () => {
    expect(getCacheName("darwin", "x64")).toBe(
      ".opencode-linear-agent-darwin-x64",
    );
  });
});
