import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Supported package managers
 */
type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/**
 * Lockfile to package manager mapping (order matters - more specific first)
 */
const LOCKFILE_MAP: Array<{ file: string; manager: PackageManager }> = [
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

/**
 * Detect the package manager used in a directory based on lockfiles
 *
 * @param directory - The directory to detect the package manager in
 * @returns The install command, or undefined if no lockfile found
 */
export function detectInstallCommand(directory: string): string | undefined {
  for (const { file, manager } of LOCKFILE_MAP) {
    if (existsSync(join(directory, file))) {
      return `${manager} install`;
    }
  }
  return undefined;
}

/**
 * Check if a bash command is a package manager install command
 *
 * Used for generating contextual "Installing dependencies..." thoughts
 */
export function isInstallCommand(command: string): boolean {
  return (
    command.includes("npm install") ||
    command.includes("yarn install") ||
    command.includes("yarn add") ||
    command.includes("pnpm install") ||
    command.includes("pnpm add") ||
    command.includes("bun install") ||
    command.includes("bun add")
  );
}
