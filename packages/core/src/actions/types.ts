import type {
  ActivityContent,
  PlanItem,
  SignalMetadata,
} from "../linear/types";
import type { ElicitationSignal } from "../linear/LinearService";

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
 * Post an error activity to a Linear session
 */
export interface PostErrorAction {
  type: "postError";
  sessionId: string;
  error: unknown;
}

/**
 * Discriminated union of all actions that processors can emit
 *
 * Per AGENTS.md design principles, this decouples "what to do" from "how to do it".
 * Pure processing functions return actions, which are then executed by the ActionExecutor.
 */
export type OpencodeAction =
  | PostActivityAction
  | PostElicitationAction
  | UpdatePlanAction
  | ReplyPermissionAction
  | ReplyQuestionAction
  | PostErrorAction;
