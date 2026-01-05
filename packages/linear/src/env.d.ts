/**
 * Type augmentation for wrangler-generated Env
 *
 * Wrangler generates untyped Queue bindings. This file provides the
 * proper generic type parameter.
 */

import type { LinearEventMessage } from "@linear-opencode-agent/core";

declare global {
  namespace Cloudflare {
    interface Env {
      // Provide typed Queue (wrangler generates untyped Queue)
      AGENT_QUEUE: Queue<LinearEventMessage>;
    }
  }
}
