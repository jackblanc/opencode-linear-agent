#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));

function getRuntime() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin" && arch === "arm64") {
    return {
      arch,
      packageName: "@opencode-linear-agent/server-darwin-arm64",
      platform,
    };
  }

  if (platform === "darwin" && arch === "x64") {
    return {
      arch,
      packageName: "@opencode-linear-agent/server-darwin-x64",
      platform,
    };
  }

  if (platform === "linux" && arch === "arm64") {
    return {
      arch,
      packageName: "@opencode-linear-agent/server-linux-arm64",
      platform,
    };
  }

  if (platform === "linux" && arch === "x64") {
    return {
      arch,
      packageName: "@opencode-linear-agent/server-linux-x64",
      platform,
    };
  }

  return null;
}

function getCache(runtime) {
  return path.join(root, "bin", `.opencode-linear-agent-${runtime.platform}-${runtime.arch}`);
}

function ensureParent(filepath) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
}

function installCache(source, cache) {
  ensureParent(cache);
  if (fs.existsSync(cache)) {
    fs.unlinkSync(cache);
  }

  if (fs.existsSync(source)) {
    fs.copyFileSync(source, cache);
  }

  if (fs.existsSync(cache)) {
    fs.chmodSync(cache, 0o755);
  }
}

function findBinary(packageName) {
  const pkg = require.resolve(`${packageName}/package.json`);
  return path.join(path.dirname(pkg), "bin", "opencode-linear-agent");
}

function main() {
  const runtime = getRuntime();
  if (!runtime) {
    return;
  }

  const bin = findBinary(runtime.packageName);
  if (!bin || !fs.existsSync(bin)) {
    return;
  }

  installCache(bin, getCache(runtime));
}

main();
