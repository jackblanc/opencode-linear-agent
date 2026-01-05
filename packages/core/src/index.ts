/**
 * Core domain logic - platform agnostic
 *
 * This package contains:
 * - EventProcessor: Main entry point for processing Linear webhook events
 * - SessionManager: Manages OpenCode session lifecycle
 * - Interfaces for external dependencies (LinearAdapter, SessionRepository, GitOperations)
 */

// Main processor
export { EventProcessor } from "./EventProcessor";
export type { EventProcessorConfig } from "./EventProcessor";

// Session management
export { SessionManager } from "./session/SessionManager";
export type { SessionState } from "./session/SessionState";
export type { SessionRepository } from "./session/SessionRepository";

// Git operations interface
export type { GitOperations } from "./git/GitOperations";
export type { GitStatus, WorktreeInfo } from "./git/types";

// Linear adapter interface
export type { LinearAdapter, ActivitySignal } from "./linear/LinearAdapter";
export type { ActivityContent, PlanItem } from "./linear/types";

// Shared types
export type { LinearEventMessage, ExecResult, ExecOptions } from "./types";
