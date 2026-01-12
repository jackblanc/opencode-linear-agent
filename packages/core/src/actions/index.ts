/**
 * Action types and executor for functional event processing
 *
 * This module provides the abstraction layer that decouples "what to do"
 * from "how to do it" per AGENTS.md design principles:
 *
 * - Events come FROM Linear/OpenCode (inputs)
 * - Actions go TO Linear/OpenCode (outputs)
 * - Pure processing functions return action objects
 * - ActionExecutor routes actions to the appropriate service
 * - Transport layer (webhooks, SSE, plugins) is abstracted away
 */

// Action types - organized by target service
export type {
  // Linear actions
  LinearAction,
  PostActivityAction,
  PostElicitationAction,
  UpdatePlanAction,
  PostErrorAction,
  // OpenCode actions
  OpencodeAction,
  ReplyPermissionAction,
  ReplyQuestionAction,
  // Combined type
  Action,
  // Handler result types
  HandlerResult,
  HandlerResultWithQuestion,
} from "./types";

export { ActionExecutor } from "./executor";
export type { ActionExecutionError, ActionResult } from "./executor";
