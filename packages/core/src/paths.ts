import { join } from "node:path";
import { xdgConfig, xdgData, xdgState } from "xdg-basedir";

const APPLICATION_DIRECTORY = "opencode-linear-agent";

function requireConfigHome(): string {
  if (xdgConfig) {
    return xdgConfig;
  }
  throw new Error(
    "Failed to resolve XDG config path. Set HOME or XDG_CONFIG_HOME.",
  );
}

function requireDataHome(): string {
  if (xdgData) {
    return xdgData;
  }
  throw new Error(
    "Failed to resolve XDG data path. Set HOME or XDG_DATA_HOME.",
  );
}

function requireStateHome(): string {
  if (xdgState) {
    return xdgState;
  }
  if (xdgData) {
    return xdgData;
  }
  throw new Error(
    "Failed to resolve XDG state path. Set HOME, XDG_STATE_HOME, or XDG_DATA_HOME.",
  );
}

export function getConfigPath(): string {
  return join(requireConfigHome(), APPLICATION_DIRECTORY, "config.json");
}

export function getStorePath(): string {
  return join(requireDataHome(), APPLICATION_DIRECTORY, "store.json");
}

export function getAuthPath(): string {
  return join(requireStateHome(), APPLICATION_DIRECTORY, "auth.json");
}
