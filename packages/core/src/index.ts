/**
 * Core domain logic - platform agnostic
 *
 * This package contains:
 * - LinearEventProcessor: Processes Linear webhook events
 * - OpencodeEventProcessor: Processes OpenCode SSE events
 * - SessionManager: Manages OpenCode session lifecycle
 * - Interfaces for external dependencies (LinearService, SessionRepository)
 */

// Re-export Result from better-result for convenience
export { Result } from "better-result";

// Event processors
export { LinearEventProcessor } from "./LinearEventProcessor";
export type { LinearEventProcessorConfig } from "./LinearEventProcessor";
export { OpencodeEventProcessor } from "./OpencodeEventProcessor";
export type { OpencodeEventResult } from "./OpencodeEventProcessor";

// Backwards compatibility aliases (deprecated - use new names)
export { LinearEventProcessor as EventProcessor } from "./LinearEventProcessor";
export type { LinearEventProcessorConfig as EventProcessorConfig } from "./LinearEventProcessor";
export { OpencodeEventProcessor as SSEEventHandler } from "./OpencodeEventProcessor";
export type { OpencodeEventResult as SSEEventResult } from "./OpencodeEventProcessor";

// Event handlers (delegates)
export {
  ToolHandler,
  TextHandler,
  TodoHandler,
  PermissionHandler,
  QuestionHandler,
  getToolActionName,
  extractToolParameter,
} from "./handlers";

// Session management
export { SessionManager } from "./session/SessionManager";
export { WorktreeManager } from "./session/WorktreeManager";
export type { WorktreeResolution } from "./session/WorktreeManager";
export { PromptBuilder } from "./session/PromptBuilder";
export type { SessionState } from "./session/SessionState";
export type {
  SessionRepository,
  WorktreeInfo,
  PendingQuestion,
  QuestionInfo,
  QuestionOption,
} from "./session/SessionRepository";

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

// Actions
export type {
  OpencodeAction,
  PostActivityAction,
  PostElicitationAction,
  UpdatePlanAction,
  ReplyPermissionAction,
  ReplyQuestionAction,
  PostErrorAction,
  ActionExecutionError,
  ActionResult,
} from "./actions";
export { ActionExecutor } from "./actions";

// OpenCode service wrapper
export { OpencodeService } from "./opencode";
export type {
  WorktreeResult,
  OpencodeSessionResult,
  MessageWithParts,
} from "./opencode";
