import { describe, test, expect } from "bun:test";
import { processTodoUpdated } from "../../src/handlers/TodoHandler";

describe("processTodoUpdated", () => {
  const ctx = {
    linearSessionId: "linear-123",
    opencodeSessionId: "opencode-456",
  };

  test("should return updatePlan action with mapped statuses", () => {
    const properties = {
      sessionID: "opencode-456",
      todos: [
        { id: "1", content: "Task 1", status: "pending", priority: "medium" },
        {
          id: "2",
          content: "Task 2",
          status: "in_progress",
          priority: "high",
        },
        { id: "3", content: "Task 3", status: "completed", priority: "low" },
        { id: "4", content: "Task 4", status: "cancelled", priority: "medium" },
      ],
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "updatePlan",
      sessionId: "linear-123",
      plan: [
        { content: "Task 1", status: "pending" },
        { content: "Task 2", status: "inProgress" },
        { content: "Task 3", status: "completed" },
        { content: "Task 4", status: "canceled" },
      ],
    });
  });

  test("should skip events for other sessions", () => {
    const properties = {
      sessionID: "other-session",
      todos: [
        { id: "1", content: "Task 1", status: "pending", priority: "medium" },
      ],
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions).toHaveLength(0);
  });

  test("should handle empty todos", () => {
    const properties = {
      sessionID: "opencode-456",
      todos: [],
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "updatePlan",
      sessionId: "linear-123",
      plan: [],
    });
  });

  test("should map unknown status to pending", () => {
    const properties = {
      sessionID: "opencode-456",
      todos: [
        { id: "1", content: "Task 1", status: "unknown", priority: "medium" },
      ],
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "updatePlan",
      plan: [{ content: "Task 1", status: "pending" }],
    });
  });
});
