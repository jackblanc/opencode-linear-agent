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
const postedQuestionElicitations = new Map<string, Set<string>>();

// Track last text part per message for final response posting
// Map<sessionId, Map<messageId, { partId: string; text: string }>>
const lastTextParts = new Map<
  string,
  Map<string, { partId: string; text: string }>
>();

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

export function setLastTextPart(
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
): void {
  let messages = lastTextParts.get(sessionId);
  if (!messages) {
    messages = new Map();
    lastTextParts.set(sessionId, messages);
  }
  messages.set(messageId, { partId, text });
}

export function getLastTextPart(
  sessionId: string,
  messageId: string,
): { partId: string; text: string } | null {
  const messages = lastTextParts.get(sessionId);
  return messages?.get(messageId) ?? null;
}

export function hasPostedFinalResponse(sessionId: string): boolean {
  return postedFinalResponse.has(sessionId);
}

/**
 * Check if a question elicitation has already been posted for this call.
 * Prevents double-posting if both tool.execute.before and event handler fire.
 */
export function markQuestionElicitationPosted(
  sessionId: string,
  callId: string,
): boolean {
  let posted = postedQuestionElicitations.get(sessionId);
  if (!posted) {
    posted = new Set();
    postedQuestionElicitations.set(sessionId, posted);
  }
  if (posted.has(callId)) return false;
  posted.add(callId);
  return true;
}
