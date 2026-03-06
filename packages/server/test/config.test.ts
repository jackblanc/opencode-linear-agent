import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createServerLogPath, getDataDir } from "../src/config";

const oldXdgDataHome = process.env["XDG_DATA_HOME"];

afterEach(() => {
  if (oldXdgDataHome) {
    process.env["XDG_DATA_HOME"] = oldXdgDataHome;
    return;
  }
  delete process.env["XDG_DATA_HOME"];
});

describe("config paths", () => {
  test("uses XDG data dir when set", () => {
    process.env["XDG_DATA_HOME"] = "/tmp/opencode-data";

    expect(getDataDir()).toBe("/tmp/opencode-data/opencode-linear-agent");
  });

  test("creates per-start server log path", () => {
    process.env["XDG_DATA_HOME"] = "/tmp/opencode-data";

    expect(createServerLogPath(new Date("2026-03-06T21:57:17.187Z"))).toBe(
      join(
        "/tmp/opencode-data",
        "opencode-linear-agent",
        "log",
        "server-20260306T215717Z.log",
      ),
    );
  });
});
