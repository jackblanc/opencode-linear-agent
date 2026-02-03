import { describe, test, expect, beforeEach } from "bun:test";
import {
  initSession,
  getSession,
  markToolRunning,
  markToolCompleted,
  isTextPartSent,
  markTextPartSent,
  markFinalResponsePosted,
  hasFinalResponsePosted,
  markErrorPosted,
  hasErrorPosted,
  storePendingQuestionArgs,
  consumePendingQuestionArgs,
} from "../src/state";

describe("state", () => {
  // Use unique session IDs to avoid state leakage between tests
  let testSessionId: string;

  beforeEach(() => {
    testSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  describe("initSession and getSession (legacy)", () => {
    // These are legacy functions that now return null/no-op
    // Session state is now read from the file store via getSessionAsync
    test("getSession should return null (legacy - reads from file store now)", () => {
      const session = getSession("any-session");
      expect(session).toBeNull();
    });

    test("initSession should be a no-op (legacy)", () => {
      // Should not throw
      expect(() => {
        initSession("session-id", {
          sessionId: "linear-123",
          issueId: "CODE-42",
          organizationId: "org-xyz",
          workdir: "/path/to/workdir",
        });
      }).not.toThrow();
    });
  });

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

    test("markToolRunning should return true for new session (creates set on demand)", () => {
      const result = markToolRunning("brand-new-session", "tool-123");

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
    test("hasFinalResponsePosted should return false initially", () => {
      const result = hasFinalResponsePosted(testSessionId);
      expect(result).toBe(false);
    });

    test("markFinalResponsePosted should set flag to true", () => {
      markFinalResponsePosted(testSessionId);
      const result = hasFinalResponsePosted(testSessionId);
      expect(result).toBe(true);
    });

    test("markFinalResponsePosted should not throw for any session", () => {
      expect(() => {
        markFinalResponsePosted("any-session");
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

  describe("pending question args", () => {
    test("storePendingQuestionArgs should store args", () => {
      const args = { questions: [{ question: "Test?", options: [] }] };

      storePendingQuestionArgs("call-123", args);
      const result = consumePendingQuestionArgs("call-123");

      expect(result).toEqual(args);
    });

    test("consumePendingQuestionArgs should remove args after consuming", () => {
      const args = { questions: [{ question: "Test?", options: [] }] };

      storePendingQuestionArgs("call-123", args);
      consumePendingQuestionArgs("call-123"); // First consume
      const result = consumePendingQuestionArgs("call-123"); // Second consume

      expect(result).toBeNull();
    });

    test("consumePendingQuestionArgs should return null for non-existent call", () => {
      const result = consumePendingQuestionArgs("non-existent");

      expect(result).toBeNull();
    });

    test("should handle multiple call IDs independently", () => {
      const args1 = { questions: [{ question: "Q1?", options: [] }] };
      const args2 = { questions: [{ question: "Q2?", options: [] }] };

      storePendingQuestionArgs("call-1", args1);
      storePendingQuestionArgs("call-2", args2);

      expect(consumePendingQuestionArgs("call-1")).toEqual(args1);
      expect(consumePendingQuestionArgs("call-2")).toEqual(args2);
      expect(consumePendingQuestionArgs("call-1")).toBeNull(); // Already consumed
    });

    test("should handle complex args", () => {
      const args = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework Selection",
            options: [
              { label: "React", description: "React framework" },
              { label: "Vue", description: "Vue framework" },
              { label: "Angular", description: "Angular framework" },
            ],
            multiple: true,
          },
        ],
      };

      storePendingQuestionArgs("call-complex", args);
      const result = consumePendingQuestionArgs("call-complex");

      expect(result).toEqual(args);
    });
  });
});
