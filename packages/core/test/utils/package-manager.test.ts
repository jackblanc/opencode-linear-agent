import { describe, test, expect } from "bun:test";
import { isInstallCommand } from "../../src/utils/package-manager";

describe("isInstallCommand", () => {
  test("should detect npm install", () => {
    expect(isInstallCommand("npm install")).toBe(true);
    expect(isInstallCommand("npm install lodash")).toBe(true);
  });

  test("should detect yarn install and add", () => {
    expect(isInstallCommand("yarn install")).toBe(true);
    expect(isInstallCommand("yarn add lodash")).toBe(true);
  });

  test("should detect pnpm install and add", () => {
    expect(isInstallCommand("pnpm install")).toBe(true);
    expect(isInstallCommand("pnpm add lodash")).toBe(true);
  });

  test("should detect bun install and add", () => {
    expect(isInstallCommand("bun install")).toBe(true);
    expect(isInstallCommand("bun add lodash")).toBe(true);
  });

  test("should not match unrelated commands", () => {
    expect(isInstallCommand("git status")).toBe(false);
    expect(isInstallCommand("bun run check")).toBe(false);
    expect(isInstallCommand("npm run test")).toBe(false);
  });
});
