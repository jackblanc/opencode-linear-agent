import { join } from "node:path";
import { xdgConfig, xdgData } from "xdg-basedir";

const APPLICATION_DIRECTORY = "opencode-linear-agent";
export interface AppPathOptions {
  configHome?: string;
  dataHome?: string;
}

function requireConfigHome(options: AppPathOptions): string {
  const root = options.configHome ?? xdgConfig;
  if (root) {
    return root;
  }
  throw new Error(
    "Failed to resolve XDG config path. Set HOME or XDG_CONFIG_HOME.",
  );
}

function requireDataHome(options: AppPathOptions): string {
  const root = options.dataHome ?? xdgData;
  if (root) {
    return root;
  }
  throw new Error(
    "Failed to resolve XDG data path. Set HOME or XDG_DATA_HOME.",
  );
}

export function getConfigPath(options: AppPathOptions = {}): string {
  return join(requireConfigHome(options), APPLICATION_DIRECTORY, "config.json");
}

export function getStorePath(options: AppPathOptions = {}): string {
  return join(requireDataHome(options), APPLICATION_DIRECTORY, "store.json");
}
