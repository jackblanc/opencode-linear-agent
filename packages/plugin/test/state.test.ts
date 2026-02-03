import { describe, test, expect, beforeEach } from "bun:test";
import {
  initSession,
  getSession,
  markToolRunning,
  markToolCompleted,
  isTextPartSent,
  markTextPartSent,
  markFinalResponsePosted,
  markErrorPosted,
  hasErrorPosted,
} from "../src/state";

describe("state", () => {
  const testLinearContext = {
    sessionId: "linear-session-123",
    issueId: "CODE-42",
    organizationId: "org-xyz",
    storePath: "/path/to/store.json",
    workdir: "/path/to/workdir",
  };

  // Use unique session IDs to avoid state leakage between tests
  let testSessionId: string;

  beforeEach(() => {
    testSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  describe("initSession and getSession", () => {
    test("should initialize session state", () => {
      initSession(testSessionId, testLinearContext);

      const session = getSession(testSessionId);

      expect(session).not.toBeNull();
      expect(session?.linear).toEqual(testLinearContext);
      expect(session?.runningTools.size).toBe(0);
      expect(session?.sentTextParts.size).toBe(0);
      expect(session?.postedFinalResponse).toBe(false);
      expect(session?.postedError).toBe(false);
    });

    test("should return null for non-existent session", () => {
      const session = getSession("non-existent-session");

      expect(session).toBeNull();
    });

    test("should overwrite session when initialized again", () => {
      initSession(testSessionId, testLinearContext);
      markToolRunning(testSessionId, "tool-1");

      const newContext = { ...testLinearContext, issueId: "CODE-99" };
      initSession(testSessionId, newContext);

      const session = getSession(testSessionId);
      expect(session?.linear.issueId).toBe("CODE-99");
      expect(session?.runningTools.size).toBe(0); // Reset
    });
  });

  describe("tool tracking", () => {
    beforeEach(() => {
      initSession(testSessionId, testLinearContext);
    });

    test("markToolRunning should return true for new tool", () => {
      const result = markToolRunning(testSessionId, "tool-123");

      expect(result).toBe(true);
    });

    test("markToolRunning should return false for already running tool", () => {
      markToolRunning(testSessionId, "tool-123");
      const result = markToolRunning(testSessionId, "tool-123");

      expect(result).toBe(false);
    });

    test("markToolRunning should return false for non-existent session", () => {
      const result = markToolRunning("non-existent", "tool-123");

      expect(result).toBe(false);
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
    beforeEach(() => {
      initSession(testSessionId, testLinearContext);
    });

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
    beforeEach(() => {
      initSession(testSessionId, testLinearContext);
    });

    test("should start with postedFinalResponse as false", () => {
      const session = getSession(testSessionId);

      expect(session?.postedFinalResponse).toBe(false);
    });

    test("markFinalResponsePosted should set postedFinalResponse to true", () => {
      markFinalResponsePosted(testSessionId);

      const session = getSession(testSessionId);
      expect(session?.postedFinalResponse).toBe(true);
    });

    test("markFinalResponsePosted should not throw for non-existent session", () => {
      expect(() => {
        markFinalResponsePosted("non-existent");
      }).not.toThrow();
    });
  });

  describe("error tracking", () => {
    beforeEach(() => {
      initSession(testSessionId, testLinearContext);
    });

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
