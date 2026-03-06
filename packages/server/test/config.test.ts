import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "../src/config";

const oldXdgDataHome = process.env["XDG_DATA_HOME"];

describe("getDataDir", () => {
  beforeEach(() => {
    delete process.env["XDG_DATA_HOME"];
  });

  afterEach(() => {
    if (oldXdgDataHome === undefined) {
      delete process.env["XDG_DATA_HOME"];
      return;
    }

    process.env["XDG_DATA_HOME"] = oldXdgDataHome;
  });

  test("uses default XDG data dir when env missing", () => {
    expect(getDataDir()).toBe(
      join(homedir(), ".local/share", "opencode-linear-agent"),
    );
  });

  test("uses XDG_DATA_HOME when set", () => {
    process.env["XDG_DATA_HOME"] = "/tmp/opencode-data";

    expect(getDataDir()).toBe("/tmp/opencode-data/opencode-linear-agent");
  });
});
