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

// ignore knip error - used in packages/server/test/AgentSessionDispatcher.test.ts
/** @public */
export type { SessionState } from "./session/SessionState";
export type {
  SessionRepository,
  PendingRepoSelection,
  RepoSelectionOption,
} from "./session/SessionRepository";
export { FileSessionRepository } from "./session/FileSessionRepository";
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
export { FileOAuthStateStore } from "./storage/FileOAuthStateStore";
export { FileTokenStore } from "./storage/FileTokenStore";
export type { TokenStore } from "./storage/types";

// OAuth handlers (consumed by server)
export type { OAuthConfig } from "./oauth/types";
export {
  handleAuthorize,
  handleCallback,
  refreshAccessToken,
} from "./oauth/handlers";

// Webhook handlers (consumed by server)
export type { EventDispatcher } from "./webhook/types";
export { handleWebhook } from "./webhook/handlers";

// Logging
export { Log, createFileLogSink } from "./logger";
export type { LogSink } from "./logger";

// Errors
export { LinearForbiddenError } from "./errors/linear";
export type { LinearServiceError } from "./errors/linear";

// Paths
export { getConfigPath, getStateRootPath } from "./paths";

// OpenCode service wrapper (consumed by server)
export { OpencodeService } from "./opencode-service/OpencodeService";
