/**
 * Pure Handler Functions
 *
 * These handlers process specific OpenCode SSE events and return
 * actions to be executed by the ActionExecutor.
 *
 * They are pure functions:
 * - Take current state as input
 * - Return new state + actions
 * - No side effects, no I/O
 */

export {
  processToolPart,
  getToolActionName,
  extractToolParameter,
  type ToolHandlerContext,
} from "./ToolHandler";

export { processTextPart, type TextHandlerContext } from "./TextHandler";

export {
  processTodoUpdated,
  type TodoHandlerContext,
  type TodoUpdatedProperties,
} from "./TodoHandler";

export {
  processPermissionAsked,
  type PermissionHandlerContext,
  type PermissionAskedProperties,
} from "./PermissionHandler";

export {
  processQuestionAsked,
  type QuestionHandlerContext,
} from "./QuestionHandler";
