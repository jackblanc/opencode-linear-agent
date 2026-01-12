/**
 * Action types and executor for functional event processing
 *
 * This module provides the abstraction layer that decouples "what to do"
 * from "how to do it" per AGENTS.md design principles:
 *
 * - Pure processing functions return action objects
 * - ActionExecutor handles the actual side effects
 * - All actions are typed discriminated unions
 */

export type {
  OpencodeAction,
  PostActivityAction,
  PostElicitationAction,
  UpdatePlanAction,
  ReplyPermissionAction,
  ReplyQuestionAction,
  PostErrorAction,
} from "./types";

export { ActionExecutor } from "./executor";
export type { ActionExecutionError, ActionResult } from "./executor";
