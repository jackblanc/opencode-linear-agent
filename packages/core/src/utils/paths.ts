import { join } from "node:path";
import { xdgConfig, xdgData } from "xdg-basedir";

const APPLICATION_DIRECTORY = "opencode-linear-agent";

function requireConfigHome(): string {
  if (xdgConfig) {
    return xdgConfig;
  }
  throw new Error("Failed to resolve XDG config path. Set HOME or XDG_CONFIG_HOME.");
}

function requireDataHome(): string {
  if (xdgData) {
    return xdgData;
  }
  throw new Error("Failed to resolve XDG data path. Set HOME or XDG_DATA_HOME.");
}

export function getConfigFilePath(): string {
  return join(requireConfigHome(), APPLICATION_DIRECTORY, "config.json");
}

export function getStateRootDirectoryPath(): string {
  return join(requireDataHome(), APPLICATION_DIRECTORY, "state");
}

export function getOAuthAccessTokenFilePath(): string {
  return join(requireDataHome(), APPLICATION_DIRECTORY, "oauth_access_token.txt");
}
