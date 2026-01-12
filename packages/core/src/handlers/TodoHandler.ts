import type { Todo } from "@opencode-ai/sdk/v2";
import type { PlanItem } from "../linear/types";
import type { Action } from "../actions/types";

/**
 * Map OpenCode todo status to Linear plan status
 */
function mapTodoStatus(
  status: string,
): "pending" | "inProgress" | "completed" | "canceled" {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    case "cancelled":
      return "canceled";
    default:
      return "pending";
  }
}

/**
 * Context needed for todo handler processing
 */
export interface TodoHandlerContext {
  linearSessionId: string;
  opencodeSessionId: string;
}

/**
 * Properties from todo.updated event
 */
export interface TodoUpdatedProperties {
  sessionID: string;
  todos: Todo[];
}

/**
 * Process a todo.updated event - pure function
 *
 * Syncs todos to Linear plan.
 * TodoHandler doesn't need HandlerState - it's stateless.
 *
 * Takes event properties and returns actions.
 * No side effects, no I/O.
 */
export function processTodoUpdated(
  properties: TodoUpdatedProperties,
  ctx: TodoHandlerContext,
): Action[] {
  const { sessionID, todos } = properties;

  // Only process for our session
  if (sessionID !== ctx.opencodeSessionId) {
    return [];
  }

  const plan: PlanItem[] = todos.map((todo) => ({
    content: todo.content,
    status: mapTodoStatus(todo.status),
  }));

  return [
    {
      type: "updatePlan",
      sessionId: ctx.linearSessionId,
      plan,
    },
  ];
}
