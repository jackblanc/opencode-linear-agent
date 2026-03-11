type Runtime = {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  packageName: string;
  artifact: string;
};

const RUNTIMES: Runtime[] = [
  {
    platform: "darwin",
    arch: "arm64",
    packageName: "@opencode-linear-agent/server-darwin-arm64",
    artifact: "opencode-linear-agent-darwin-arm64",
  },
  {
    platform: "darwin",
    arch: "x64",
    packageName: "@opencode-linear-agent/server-darwin-x64",
    artifact: "opencode-linear-agent-darwin-x64",
  },
  {
    platform: "linux",
    arch: "arm64",
    packageName: "@opencode-linear-agent/server-linux-arm64",
    artifact: "opencode-linear-agent-linux-arm64",
  },
  {
    platform: "linux",
    arch: "x64",
    packageName: "@opencode-linear-agent/server-linux-x64",
    artifact: "opencode-linear-agent-linux-x64",
  },
];

function getCacheName(platform: string, arch: string): string {
  return `.opencode-linear-agent-${platform}-${arch}`;
}

export { getCacheName, RUNTIMES, type Runtime };
