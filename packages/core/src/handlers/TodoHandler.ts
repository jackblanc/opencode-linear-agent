import type { Todo } from "@opencode-ai/sdk/v2";
import type { LinearService } from "../linear/LinearService";
import type { PlanItem } from "../linear/types";
import type { Logger } from "../logger";

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
 * Handles todo.updated events and syncs to Linear plan.
 */
export class TodoHandler {
  constructor(
    private readonly linear: LinearService,
    private readonly linearSessionId: string,
    private readonly opencodeSessionId: string,
    private readonly log: Logger,
  ) {}

  /**
   * Handle todo.updated event - sync todos to Linear plan
   */
  async handleTodoUpdated(properties: {
    sessionID: string;
    todos: Todo[];
  }): Promise<void> {
    const { sessionID, todos } = properties;

    this.log.info("Received todo.updated event", {
      eventSessionID: sessionID,
      ourSessionID: this.opencodeSessionId,
      todoCount: todos.length,
    });

    // Only process for our session
    if (sessionID !== this.opencodeSessionId) {
      this.log.info("Skipping todo.updated - session ID mismatch");
      return;
    }

    const plan: PlanItem[] = todos.map((todo) => ({
      content: todo.content,
      status: mapTodoStatus(todo.status),
    }));

    this.log.info("Syncing todos to Linear plan", {
      todoCount: todos.length,
      items: plan.map((p) => `${p.status}: ${p.content}`),
    });

    await this.linear.updatePlan(this.linearSessionId, plan);

    this.log.info("Plan update complete");
  }
}
