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
 * Activity content for Linear
 */
export interface ActivityContent {
  type: "thought" | "action" | "response" | "error" | "elicitation";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

/**
 * Git status for determining session completion
 */
export interface GitStatus {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  branchName: string;
}

/**
 * Worktree information
 */
export interface WorktreeInfo {
  workdir: string;
  branchName: string;
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
