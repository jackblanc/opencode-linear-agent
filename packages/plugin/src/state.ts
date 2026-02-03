/**
 * Session state management for tracking Linear context and event processing state.
 *
 * Session context is read directly from the file store - no in-memory caching.
 * Ephemeral state (running tools, sent text parts) uses in-memory maps keyed by session ID.
 */

import type { LinearContext } from "./parser";
import { readSessionByOpencodeId, readAnyAccessTokenWithOrg } from "./storage";

/**
 * Per-session state for event processing
 */
export interface SessionState {
  linear: LinearContext;
  runningTools: Set<string>;
  sentTextParts: Set<string>;
  postedFinalResponse: boolean;
  postedError: boolean;
}

// Ephemeral state - okay to lose on restart since it just prevents duplicate posts
const runningTools = new Map<string, Set<string>>();
const sentTextParts = new Map<string, Set<string>>();
const postedFinalResponse = new Set<string>();
const postedError = new Set<string>();

/**
 * Get session state by reading from file store.
 * Returns null if session not found.
 */
export async function getSessionAsync(
  opencodeSessionId: string,
): Promise<SessionState | null> {
  const stored = await readSessionByOpencodeId(opencodeSessionId);
  if (!stored) return null;

  // Get organization ID from token store
  const tokenInfo = await readAnyAccessTokenWithOrg();
  if (!tokenInfo) return null;

  const linear: LinearContext = {
    sessionId: stored.linearSessionId,
    issueId: stored.issueId,
    organizationId: tokenInfo.organizationId,
    workdir: stored.workdir,
  };

  return {
    linear,
    runningTools: runningTools.get(opencodeSessionId) ?? new Set(),
    sentTextParts: sentTextParts.get(opencodeSessionId) ?? new Set(),
    postedFinalResponse: postedFinalResponse.has(opencodeSessionId),
    postedError: postedError.has(opencodeSessionId),
  };
}

// Legacy sync function - always returns null, use getSessionAsync instead
export function getSession(_sessionId: string): SessionState | null {
  return null;
}

// Legacy function - sessions are created by server, not plugin
export function initSession(_sessionId: string, _linear: LinearContext): void {
  // No-op - sessions are managed by server and stored in file store
}

export function markToolRunning(sessionId: string, toolId: string): boolean {
  let tools = runningTools.get(sessionId);
  if (!tools) {
    tools = new Set();
    runningTools.set(sessionId, tools);
  }
  if (tools.has(toolId)) return false;
  tools.add(toolId);
  return true;
}

export function markToolCompleted(sessionId: string, toolId: string): void {
  const tools = runningTools.get(sessionId);
  if (tools) tools.delete(toolId);
}

export function isTextPartSent(sessionId: string, partId: string): boolean {
  const parts = sentTextParts.get(sessionId);
  return parts?.has(partId) ?? false;
}

export function markTextPartSent(sessionId: string, partId: string): void {
  let parts = sentTextParts.get(sessionId);
  if (!parts) {
    parts = new Set();
    sentTextParts.set(sessionId, parts);
  }
  parts.add(partId);
}

export function markFinalResponsePosted(sessionId: string): void {
  postedFinalResponse.add(sessionId);
}

export function markErrorPosted(sessionId: string): void {
  postedError.add(sessionId);
}

export function hasErrorPosted(sessionId: string): boolean {
  return postedError.has(sessionId);
}
