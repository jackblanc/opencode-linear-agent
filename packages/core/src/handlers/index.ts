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

export { processToolPart } from "./ToolHandler";

export { processTextPart, processSessionIdle } from "./TextHandler";

export { processTodoUpdated } from "./TodoHandler";

export { processPermissionAsked } from "./PermissionHandler";

export { processQuestionAsked } from "./QuestionHandler";

export {
  processSessionError,
  type SessionErrorProperties,
} from "./SessionErrorHandler";
