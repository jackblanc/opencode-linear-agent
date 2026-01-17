/**
 * Session state management for tracking Linear context and event processing state.
 */

import type { LinearContext } from "./parser";

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

const sessions = new Map<string, SessionState>();
const pendingQuestionArgs = new Map<string, unknown>();

export function storePendingQuestionArgs(callId: string, args: unknown): void {
  pendingQuestionArgs.set(callId, args);
}

export function consumePendingQuestionArgs(callId: string): unknown {
  const args = pendingQuestionArgs.get(callId);
  if (args !== undefined) {
    pendingQuestionArgs.delete(callId);
    return args;
  }
  return null;
}

export function initSession(sessionId: string, linear: LinearContext): void {
  sessions.set(sessionId, {
    linear,
    runningTools: new Set(),
    sentTextParts: new Set(),
    postedFinalResponse: false,
    postedError: false,
  });
}

export function getSession(sessionId: string): SessionState | null {
  return sessions.get(sessionId) ?? null;
}

export function markToolRunning(sessionId: string, toolId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) return false;
  if (state.runningTools.has(toolId)) return false;
  state.runningTools.add(toolId);
  return true;
}

export function markToolCompleted(sessionId: string, toolId: string): void {
  const state = sessions.get(sessionId);
  if (state) state.runningTools.delete(toolId);
}

export function isTextPartSent(sessionId: string, partId: string): boolean {
  const state = sessions.get(sessionId);
  return state?.sentTextParts.has(partId) ?? false;
}

export function markTextPartSent(sessionId: string, partId: string): void {
  const state = sessions.get(sessionId);
  if (state) state.sentTextParts.add(partId);
}

export function markFinalResponsePosted(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state) state.postedFinalResponse = true;
}

export function markErrorPosted(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state) state.postedError = true;
}

export function hasErrorPosted(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  return state?.postedError ?? false;
}
