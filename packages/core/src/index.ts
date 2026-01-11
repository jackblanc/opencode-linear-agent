/**
 * Core domain logic - platform agnostic
 *
 * This package contains:
 * - EventProcessor: Main entry point for processing Linear webhook events
 * - SessionManager: Manages OpenCode session lifecycle
 * - Interfaces for external dependencies (LinearService, SessionRepository)
 */

// Re-export Result from better-result for convenience
export { Result } from "better-result";

// Main processor
export { EventProcessor } from "./EventProcessor";
export type { EventProcessorConfig } from "./EventProcessor";

// SSE event handler
export { SSEEventHandler } from "./SSEEventHandler";
export type { SSEEventResult } from "./SSEEventHandler";

// Session management
export { SessionManager } from "./session/SessionManager";
export type { SessionState } from "./session/SessionState";
export type { SessionRepository } from "./session/SessionRepository";

// Linear service interface and implementation
export type {
  LinearService,
  LinearIssue,
  LinearLabel,
  LinearAttachment,
  ElicitationSignal,
} from "./linear/LinearService";
export { LinearServiceImpl } from "./linear/LinearServiceImpl";
export type {
  ActivityContent,
  PlanItem,
  ProcessingStage,
} from "./linear/types";
export { STAGE_MESSAGES } from "./linear/types";

// Label parsing
export { parseRepoLabel } from "./linear/label-parser";
export type { ParsedRepoLabel, LinearLabelLike } from "./linear/label-parser";

// Shared types
export type { LinearEventMessage, ExecResult, ExecOptions } from "./types";

// Storage interfaces
export type { KeyValueStore, TokenStore, RefreshTokenData } from "./storage";

// OAuth handlers
export type { OAuthConfig, OAuthCallbackResult } from "./oauth";
export { handleAuthorize, handleCallback, refreshAccessToken } from "./oauth";

// Webhook handlers
export type {
  EventDispatcher,
  LinearStatusPoster,
  LinearStatusPosterFactory,
} from "./webhook";
export { handleWebhook } from "./webhook";

// Utilities
export { base64Encode, base64Decode } from "./utils/encode";

// Logging
export { Log, createLogger, initLogger, defaultLogger } from "./logger";
export type { Logger, LogLevel, LogFormat, LogInitOptions } from "./logger";

// Errors
export * from "./errors";

// OpenCode service wrapper
export { OpencodeService } from "./opencode";
export type {
  WorktreeResult,
  SessionResult as OpencodeSessionResult,
  MessageWithParts,
} from "./opencode";
