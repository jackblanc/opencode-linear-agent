import type {
  ActivityContent,
  PlanItem,
  SignalMetadata,
} from "../linear/types";
import type { ElicitationSignal } from "../linear/LinearService";
import type {
  PendingQuestion,
  PendingPermission,
} from "../session/SessionRepository";

// ─────────────────────────────────────────────────────────────────────────────
// Linear Actions - executed against LinearService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post an activity to a Linear session
 */
export interface PostActivityAction {
  type: "postActivity";
  sessionId: string;
  content: ActivityContent;
  ephemeral: boolean;
}

/**
 * Post an elicitation activity to request user input
 */
export interface PostElicitationAction {
  type: "postElicitation";
  sessionId: string;
  body: string;
  signal: ElicitationSignal;
  metadata?: SignalMetadata;
}

/**
 * Update the plan for a Linear session
 */
export interface UpdatePlanAction {
  type: "updatePlan";
  sessionId: string;
  plan: PlanItem[];
}

/**
 * Post an error activity to a Linear session
 */
export interface PostErrorAction {
  type: "postError";
  sessionId: string;
  error: unknown;
}

/**
 * Actions targeting Linear
 *
 * These actions are executed against the LinearService to update
 * session state, post activities, or communicate with users.
 */
export type LinearAction =
  | PostActivityAction
  | PostElicitationAction
  | UpdatePlanAction
  | PostErrorAction;

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode Actions - executed against OpencodeService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reply to an OpenCode permission request
 */
export interface ReplyPermissionAction {
  type: "replyPermission";
  requestId: string;
  reply: "always" | "once" | "reject";
  directory?: string;
}

/**
 * Reply to an OpenCode question request
 */
export interface ReplyQuestionAction {
  type: "replyQuestion";
  requestId: string;
  answers: Array<Array<string>>;
  directory?: string;
}

/**
 * Actions targeting OpenCode
 *
 * These actions are executed against the OpencodeService to respond
 * to permission requests, questions, or other interactive prompts.
 */
export type OpencodeAction = ReplyPermissionAction | ReplyQuestionAction;

// ─────────────────────────────────────────────────────────────────────────────
// Combined Action Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All actions that event processors can emit
 *
 * Per AGENTS.md design principles:
 * - Events come FROM Linear/OpenCode (inputs)
 * - Actions go TO Linear/OpenCode (outputs)
 * - This decouples "what to do" from "how to do it"
 * - Transport layer (webhooks, SSE, plugins) is an implementation detail
 *
 * Pure processing functions return actions, which are then executed
 * by the action execution helpers that route to the appropriate service.
 */
export type Action = LinearAction | OpencodeAction;

// ─────────────────────────────────────────────────────────────────────────────
// Handler Result Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result from a pure handler function
 *
 * Handlers take state as input and return new state + actions.
 * No side effects, no I/O - pure functions.
 */
export interface HandlerResult<TState> {
  state: TState;
  actions: Action[];
}

/**
 * Extended handler result that can also return a pending question
 *
 * Used by QuestionHandler when a question needs to be stored
 */
export interface HandlerResultWithQuestion {
  actions: Action[];
  pendingQuestion?: PendingQuestion;
}

/**
 * Handler result for permission requests
 *
 * Used by PermissionHandler - simpler since it doesn't need handler state
 */
export interface HandlerResultWithPermission {
  actions: Action[];
  pendingPermission?: PendingPermission;
}
