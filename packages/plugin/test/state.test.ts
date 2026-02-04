import { describe, test, expect, beforeEach } from "bun:test";
import {
  markToolRunning,
  markToolCompleted,
  isTextPartSent,
  markTextPartSent,
  markFinalResponsePosted,
  markErrorPosted,
  hasErrorPosted,
  hasPostedFinalResponse,
} from "../src/state";

describe("state", () => {
  // Use unique session IDs to avoid state leakage between tests
  let testSessionId: string;

  beforeEach(() => {
    testSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  // Note: initSession and getSession are legacy functions that are now no-ops.
  // Session state is managed by the server and read from file store.
  // These tests focus on the ephemeral state tracking functions.

  describe("tool tracking", () => {
    test("markToolRunning should return true for new tool", () => {
      const result = markToolRunning(testSessionId, "tool-123");

      expect(result).toBe(true);
    });

    test("markToolRunning should return false for already running tool", () => {
      markToolRunning(testSessionId, "tool-123");
      const result = markToolRunning(testSessionId, "tool-123");

      expect(result).toBe(false);
    });

    test("markToolRunning should return true for new session (ephemeral state)", () => {
      // Ephemeral state is created on-demand, so a new session works
      const result = markToolRunning("any-session", "tool-123");

      expect(result).toBe(true);
    });

    test("markToolCompleted should remove tool from running set", () => {
      markToolRunning(testSessionId, "tool-123");
      markToolCompleted(testSessionId, "tool-123");

      // Should be able to mark as running again
      const result = markToolRunning(testSessionId, "tool-123");
      expect(result).toBe(true);
    });

    test("markToolCompleted should not throw for non-running tool", () => {
      expect(() => {
        markToolCompleted(testSessionId, "non-existent-tool");
      }).not.toThrow();
    });

    test("should track multiple tools independently", () => {
      const result1 = markToolRunning(testSessionId, "tool-1");
      const result2 = markToolRunning(testSessionId, "tool-2");
      const result3 = markToolRunning(testSessionId, "tool-1"); // Duplicate

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(result3).toBe(false);

      markToolCompleted(testSessionId, "tool-1");

      const result4 = markToolRunning(testSessionId, "tool-1"); // Now available
      const result5 = markToolRunning(testSessionId, "tool-2"); // Still running

      expect(result4).toBe(true);
      expect(result5).toBe(false);
    });
  });

  describe("text part tracking", () => {
    test("isTextPartSent should return false for unsent part", () => {
      const result = isTextPartSent(testSessionId, "part-123");

      expect(result).toBe(false);
    });

    test("markTextPartSent should mark part as sent", () => {
      markTextPartSent(testSessionId, "part-123");

      const result = isTextPartSent(testSessionId, "part-123");
      expect(result).toBe(true);
    });

    test("isTextPartSent should return false for non-existent session", () => {
      const result = isTextPartSent("non-existent", "part-123");

      expect(result).toBe(false);
    });

    test("should track multiple text parts independently", () => {
      markTextPartSent(testSessionId, "part-1");
      markTextPartSent(testSessionId, "part-2");

      expect(isTextPartSent(testSessionId, "part-1")).toBe(true);
      expect(isTextPartSent(testSessionId, "part-2")).toBe(true);
      expect(isTextPartSent(testSessionId, "part-3")).toBe(false);
    });
  });

  describe("final response tracking", () => {
    test("hasPostedFinalResponse should return false initially", () => {
      const result = hasPostedFinalResponse(testSessionId);

      expect(result).toBe(false);
    });

    test("markFinalResponsePosted should set postedFinalResponse to true", () => {
      markFinalResponsePosted(testSessionId);

      const result = hasPostedFinalResponse(testSessionId);
      expect(result).toBe(true);
    });

    test("markFinalResponsePosted should not throw for non-existent session", () => {
      expect(() => {
        markFinalResponsePosted("non-existent");
      }).not.toThrow();
    });
  });

  describe("error tracking", () => {
    test("hasErrorPosted should return false initially", () => {
      const result = hasErrorPosted(testSessionId);

      expect(result).toBe(false);
    });

    test("markErrorPosted should set error as posted", () => {
      markErrorPosted(testSessionId);

      const result = hasErrorPosted(testSessionId);
      expect(result).toBe(true);
    });

    test("hasErrorPosted should return false for non-existent session", () => {
      const result = hasErrorPosted("non-existent");

      expect(result).toBe(false);
    });

    test("markErrorPosted should not throw for non-existent session", () => {
      expect(() => {
        markErrorPosted("non-existent");
      }).not.toThrow();
    });
  });
});
