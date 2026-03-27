// Config Module
export type { ApplicationConfig } from "./config/schema";
export { loadApplicationConfig } from "./config/reader";

// Linear Event Processor Module
export { LinearEventProcessor } from "./linear-event-processor/LinearEventProcessor";
export { IssueEventHandler } from "./linear-event-processor/IssueEventHandler";

// Linear Service Module
export type { IssueRepositoryCandidate } from "./linear-service/types";
export { LinearService } from "./linear-service/LinearService";
export { findRepoLabel } from "./linear-service/label-parser";
export { parseRepoLabel } from "./linear-service/label-parser";
// Errors
export { LinearForbiddenError } from "./linear-service/errors";
export type { LinearServiceError } from "./linear-service/errors";

// OAuth Handler Module
export type { OAuthConfig } from "./oauth/types";
export {
  handleAuthorize,
  handleCallback,
  refreshAccessToken,
} from "./oauth/handlers";

// OpenCode Event Processor Module
export { OpencodeEventProcessor } from "./opencode-event-processor/OpencodeEventProcessor";

// OpenCode Service Module
export { OpencodeService } from "./opencode-service/OpencodeService";

// Session State Module
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

// Application State Module
export { OAuthStateRepository } from "./state/OAuthStateRepository";
export { AuthRepository } from "./state/AuthRepository";
export { createFileAgentState } from "./state/root";

// Util Module
export { Log, createFileLogSink } from "./utils/logger";
export type { LogSink } from "./utils/logger";
export { getStateRootPath } from "./utils/paths";

// Webhook Handler Module
export type { EventDispatcher } from "./webhook/types";
export { handleWebhook } from "./webhook/handlers";
