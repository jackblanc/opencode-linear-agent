/**
 * Core domain logic - platform agnostic
 *
 * This package contains:
 * - LinearEventProcessor: Processes Linear webhook events
 * - Pure handler functions for OpenCode event processing
 * - Interfaces for external dependencies (LinearService, SessionRepository)
 *
 * Note: OpenCode event processing is handled by the plugin, not this package.
 * The LinearEventProcessor sends prompts fire-and-forget, and the plugin
 * handles all event streaming to Linear.
 */

// Event processor
export { LinearEventProcessor } from "./LinearEventProcessor";
export { IssueEventHandler } from "./IssueEventHandler";

// Pure handler functions (consumed by plugin orchestrator)
export {
  processToolPart,
  processReasoningPart,
  processSessionIdle,
  processTodoUpdated,
  processPermissionAsked,
  processQuestionAsked,
  processSessionError,
} from "./handlers";
export type { SessionErrorProperties } from "./handlers";

// Action execution (consumed by plugin orchestrator)
export { executeActions } from "./actions";

// Session state (consumed by plugin orchestrator)
export { createInitialHandlerState } from "./session/SessionState";
export type { SessionState } from "./session/SessionState";
export type {
  SessionRepository,
  PendingQuestion,
  PendingPermission,
  PendingRepoSelection,
  RepoSelectionOption,
} from "./session/SessionRepository";
export { WorktreeManager } from "./session/WorktreeManager";

// Linear service interface and implementation
export type {
  LinearService,
  IssueRepositoryCandidate,
} from "./linear/LinearService";
export { LinearServiceImpl } from "./linear/LinearServiceImpl";

// Label parsing
export { findRepoLabel } from "./linear/label-parser";
export { parseRepoLabel } from "./linear/label-parser";

// Storage interfaces
export type { KeyValueStore, TokenStore, RefreshTokenData } from "./storage";

// OAuth handlers (consumed by server)
export type { OAuthConfig } from "./oauth";
export { handleAuthorize, handleCallback, refreshAccessToken } from "./oauth";

// Webhook handlers (consumed by server)
export type { EventDispatcher } from "./webhook";
export { handleWebhook } from "./webhook";

// Logging
export { Log } from "./logger";

// Errors
export { LinearForbiddenError } from "./errors/linear";
export type { LinearServiceError } from "./errors/linear";

// Paths
export { getConfigPath, getStorePath } from "./paths";

// Zod schemas for runtime validation
export { parseStoreData } from "./schemas";
export type { StoredValue, StoreData } from "./schemas";

// OpenCode service wrapper (consumed by server)
export { OpencodeService } from "./opencode";
