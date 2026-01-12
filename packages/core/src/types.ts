/**
 * Core domain types - platform agnostic
 */

import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";

/**
 * Message format for queue events
 */
export interface LinearEventMessage {
  payload: AgentSessionEventWebhookPayload;
  workerUrl: string;
}

/**
 * Result of command execution
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for command execution
 */
export interface ExecOptions {
  cwd?: string;
  timeout?: number;
}
