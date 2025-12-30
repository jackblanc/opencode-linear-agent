import type { Config } from "@opencode-ai/sdk";

/**
 * Get OpenCode configuration with provider settings
 */
export function getConfig(env: Env): Config {
  return {
    provider: {
      anthropic: {
        options: {
          apiKey: env.ANTHROPIC_API_KEY,
        },
      },
    },
  };
}
