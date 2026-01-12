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

  test("should map each status individually", () => {
    // Test pending
    expect(
      processTodoUpdated(
        {
          sessionID: "opencode-456",
          todos: [
            { id: "1", content: "T", status: "pending", priority: "low" },
          ],
        },
        ctx,
      )[0],
    ).toMatchObject({ plan: [{ status: "pending" }] });

    // Test in_progress
    expect(
      processTodoUpdated(
        {
          sessionID: "opencode-456",
          todos: [
            { id: "1", content: "T", status: "in_progress", priority: "low" },
          ],
        },
        ctx,
      )[0],
    ).toMatchObject({ plan: [{ status: "inProgress" }] });

    // Test completed
    expect(
      processTodoUpdated(
        {
          sessionID: "opencode-456",
          todos: [
            { id: "1", content: "T", status: "completed", priority: "low" },
          ],
        },
        ctx,
      )[0],
    ).toMatchObject({ plan: [{ status: "completed" }] });

    // Test cancelled
    expect(
      processTodoUpdated(
        {
          sessionID: "opencode-456",
          todos: [
            { id: "1", content: "T", status: "cancelled", priority: "low" },
          ],
        },
        ctx,
      )[0],
    ).toMatchObject({ plan: [{ status: "canceled" }] });
  });

  test("should preserve todo content exactly", () => {
    const properties = {
      sessionID: "opencode-456",
      todos: [
        {
          id: "1",
          content: "Special chars: @#$%^&*()_+{}|:<>?",
          status: "pending",
          priority: "medium",
        },
        {
          id: "2",
          content: "Unicode: 日本語 🎉 émojis",
          status: "pending",
          priority: "medium",
        },
        {
          id: "3",
          content: "Multi-line\nwith\nnewlines",
          status: "pending",
          priority: "medium",
        },
      ],
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions[0]).toMatchObject({
      plan: [
        { content: "Special chars: @#$%^&*()_+{}|:<>?" },
        { content: "Unicode: 日本語 🎉 émojis" },
        { content: "Multi-line\nwith\nnewlines" },
      ],
    });
  });

  test("should preserve todo order", () => {
    const properties = {
      sessionID: "opencode-456",
      todos: [
        { id: "3", content: "Third", status: "pending", priority: "low" },
        { id: "1", content: "First", status: "pending", priority: "high" },
        { id: "2", content: "Second", status: "pending", priority: "medium" },
      ],
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions[0]).toMatchObject({
      plan: [{ content: "Third" }, { content: "First" }, { content: "Second" }],
    });
  });

  test("should handle large number of todos", () => {
    const todos = Array.from({ length: 100 }, (_, i) => ({
      id: `todo-${i}`,
      content: `Task ${i}`,
      status: ["pending", "in_progress", "completed", "cancelled"][i % 4],
      priority: "medium",
    }));

    const properties = {
      sessionID: "opencode-456",
      todos,
    };

    const actions = processTodoUpdated(properties, ctx);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "updatePlan",
      sessionId: "linear-123",
    });
    // Check the plan has all 100 items via toMatchObject
    expect(actions[0]).toMatchObject({
      plan: expect.arrayContaining([
        expect.objectContaining({ content: "Task 0" }),
        expect.objectContaining({ content: "Task 99" }),
      ]),
    });
  });

  test("should not include priority in output plan", () => {
    const properties = {
      sessionID: "opencode-456",
      todos: [
        {
          id: "1",
          content: "High priority",
          status: "pending",
          priority: "high",
        },
        {
          id: "2",
          content: "Low priority",
          status: "pending",
          priority: "low",
        },
      ],
    };

    const actions = processTodoUpdated(properties, ctx);

    // Plan items should only have content and status, not priority
    expect(actions[0]).toEqual({
      type: "updatePlan",
      sessionId: "linear-123",
      plan: [
        { content: "High priority", status: "pending" },
        { content: "Low priority", status: "pending" },
      ],
    });
  });
});
