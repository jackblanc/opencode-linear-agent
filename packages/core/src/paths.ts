import { join } from "node:path";

const APPLICATION_DIRECTORY = "opencode-linear-agent";
const OPENCODE_DIRECTORY = "opencode";

export interface PathEnvironment {
  HOME?: string;
  XDG_CACHE_HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
  XDG_RUNTIME_DIR?: string;
  XDG_STATE_HOME?: string;
}

interface AppPaths {
  configDir: string;
  configFile: string;
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  runtimeDir: string;
  storeFile: string;
  launchdLogFile: string;
  launchdErrFile: string;
  opencodeConfigDir: string;
  opencodePluginDir: string;
  opencodePluginFile: string;
}

type RootKind = "cache" | "config" | "data" | "state";

function getProcessEnvironment(): PathEnvironment {
  return {
    HOME: process.env.HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
}

function readVar(
  env: PathEnvironment,
  key: keyof PathEnvironment,
): string | null {
  const value = env[key];
  if (!value) {
    return null;
  }
  return value;
}

function requireHome(env: PathEnvironment, kind: RootKind): string {
  const home = readVar(env, "HOME");
  if (home) {
    return home;
  }
  throw new Error(
    `Failed to resolve XDG ${kind} path. Set HOME or XDG_${kind.toUpperCase()}_HOME.`,
  );
}

function resolveRoot(env: PathEnvironment, kind: RootKind): string {
  switch (kind) {
    case "config": {
      const root = readVar(env, "XDG_CONFIG_HOME");
      if (root) {
        return root;
      }
      return join(requireHome(env, kind), ".config");
    }
    case "data": {
      const root = readVar(env, "XDG_DATA_HOME");
      if (root) {
        return root;
      }
      return join(requireHome(env, kind), ".local", "share");
    }
    case "cache": {
      const root = readVar(env, "XDG_CACHE_HOME");
      if (root) {
        return root;
      }
      return join(requireHome(env, kind), ".cache");
    }
    case "state": {
      const root = readVar(env, "XDG_STATE_HOME");
      if (root) {
        return root;
      }
      return join(requireHome(env, kind), ".local", "state");
    }
  }
}

function resolveRuntimeDir(env: PathEnvironment, stateDir: string): string {
  const root = readVar(env, "XDG_RUNTIME_DIR");
  if (root) {
    return join(root, APPLICATION_DIRECTORY);
  }
  return join(stateDir, "runtime");
}

export function getAppPaths(
  env: PathEnvironment = getProcessEnvironment(),
): AppPaths {
  const configDir = join(resolveRoot(env, "config"), APPLICATION_DIRECTORY);
  const dataDir = join(resolveRoot(env, "data"), APPLICATION_DIRECTORY);
  const cacheDir = join(resolveRoot(env, "cache"), APPLICATION_DIRECTORY);
  const stateDir = join(resolveRoot(env, "state"), APPLICATION_DIRECTORY);
  const runtimeDir = resolveRuntimeDir(env, stateDir);
  const opencodeConfigDir = join(
    resolveRoot(env, "config"),
    OPENCODE_DIRECTORY,
  );
  const opencodePluginDir = join(opencodeConfigDir, "plugin");

  return {
    configDir,
    configFile: join(configDir, "config.json"),
    dataDir,
    cacheDir,
    stateDir,
    runtimeDir,
    storeFile: join(stateDir, "store.json"),
    launchdLogFile: join(stateDir, "launchd.log"),
    launchdErrFile: join(stateDir, "launchd.err"),
    opencodeConfigDir,
    opencodePluginDir,
    opencodePluginFile: join(opencodePluginDir, "linear.js"),
  };
}
