/**
 * OpenCode configuration for the Agent worker
 */

import type { OpencodeServerConfig } from "@linear-opencode-agent/infrastructure";

interface ConfigEnv {
  ANTHROPIC_API_KEY: string;
}

/**
 * Get OpenCode server configuration
 */
export function getConfig(env: ConfigEnv): OpencodeServerConfig {
  return {
    config: {
      provider: {
        anthropic: {
          options: {
            apiKey: env.ANTHROPIC_API_KEY,
          },
        },
      },
    },
  };
}
