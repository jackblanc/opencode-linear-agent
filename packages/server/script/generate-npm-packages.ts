import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIMES, getCacheName, type Runtime } from "../src/runtime";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist", "npm");
const version =
  process.env.SERVER_NPM_VERSION ?? process.env.npm_package_version;

function assertVersion(): string {
  if (!version) {
    throw new Error("SERVER_NPM_VERSION or npm_package_version is required");
  }

  return version;
}

function makeDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function makeRuntimePackage(runtime: Runtime, pkgVersion: string): void {
  const dir = join(dist, runtime.packageName);
  const bin = join(dir, "bin");
  const source = join(root, "dist", runtime.artifact);
  const target = join(bin, "opencode-linear-agent");

  if (!existsSync(source)) {
    throw new Error(`Missing binary artifact: ${source}`);
  }

  makeDir(bin);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  copyFileSync(join(root, "..", "..", "LICENSE"), join(dir, "LICENSE"));
  writeJson(join(dir, "package.json"), {
    name: runtime.packageName,
    version: pkgVersion,
    type: "module",
    bin: {
      "opencode-linear-agent": "bin/opencode-linear-agent",
    },
    files: ["bin/opencode-linear-agent", "LICENSE"],
    os: [runtime.platform],
    cpu: [runtime.arch],
    publishConfig: {
      access: "public",
    },
    repository: {
      type: "git",
      url: "git+https://github.com/jackblanc/opencode-linear-agent.git",
    },
    license: "MIT",
  });
}

function makeLauncherPackage(pkgVersion: string): void {
  const dir = join(dist, "@opencode-linear-agent/server");
  const launcherBin = join(dir, "bin");
  const launcherPath = join(launcherBin, "opencode-linear-agent");

  makeDir(launcherBin);
  copyFileSync(join(root, "bin", "opencode-linear-agent"), launcherPath);
  chmodSync(launcherPath, 0o755);
  copyFileSync(join(root, "postinstall.mjs"), join(dir, "postinstall.mjs"));
  copyFileSync(join(root, "..", "..", "LICENSE"), join(dir, "LICENSE"));
  writeJson(join(dir, "package.json"), {
    name: "@opencode-linear-agent/server",
    version: pkgVersion,
    type: "module",
    bin: {
      "opencode-linear-agent": "bin/opencode-linear-agent",
    },
    files: ["bin", "postinstall.mjs", "LICENSE"],
    publishConfig: {
      access: "public",
    },
    repository: {
      type: "git",
      url: "git+https://github.com/jackblanc/opencode-linear-agent.git",
    },
    scripts: {
      postinstall: "node ./postinstall.mjs || true",
    },
    optionalDependencies: Object.fromEntries(
      RUNTIMES.map((runtime) => [runtime.packageName, pkgVersion]),
    ),
    opencodeLinearAgent: {
      cacheFiles: RUNTIMES.map((runtime) =>
        getCacheName(runtime.platform, runtime.arch),
      ),
    },
    license: "MIT",
  });
}

function main(): void {
  const pkgVersion = assertVersion();
  rmSync(dist, { recursive: true, force: true });
  for (const runtime of RUNTIMES) {
    makeRuntimePackage(runtime, pkgVersion);
  }
  makeLauncherPackage(pkgVersion);
}

main();
