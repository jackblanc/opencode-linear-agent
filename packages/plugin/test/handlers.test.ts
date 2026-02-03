import { describe, test, expect } from "bun:test";
import {
  getToolActionName,
  extractParameter,
  truncate,
  mapTodoStatus,
  getToolThought,
} from "../src/handlers";

describe("handlers pure functions", () => {
  describe("getToolActionName", () => {
    test("should return mapped action names for known tools (running)", () => {
      expect(getToolActionName("read", false)).toBe("Reading");
      expect(getToolActionName("edit", false)).toBe("Editing");
      expect(getToolActionName("write", false)).toBe("Creating");
      expect(getToolActionName("bash", false)).toBe("Running");
      expect(getToolActionName("glob", false)).toBe("Searching files");
      expect(getToolActionName("grep", false)).toBe("Searching code");
      expect(getToolActionName("task", false)).toBe("Delegating task");
      expect(getToolActionName("todowrite", false)).toBe("Updating plan");
      expect(getToolActionName("todoread", false)).toBe("Reading plan");
      expect(getToolActionName("question", false)).toBe("Asking question");
      expect(getToolActionName("mcp_question", false)).toBe("Asking question");
    });

    test("should return mapped past tense names for known tools (completed)", () => {
      expect(getToolActionName("read", true)).toBe("Read");
      expect(getToolActionName("edit", true)).toBe("Edited");
      expect(getToolActionName("write", true)).toBe("Created");
      expect(getToolActionName("bash", true)).toBe("Ran");
      expect(getToolActionName("glob", true)).toBe("Searched files");
      expect(getToolActionName("grep", true)).toBe("Searched code");
      expect(getToolActionName("task", true)).toBe("Delegated task");
      expect(getToolActionName("todowrite", true)).toBe("Updated plan");
      expect(getToolActionName("todoread", true)).toBe("Read plan");
      expect(getToolActionName("question", true)).toBe("Asked question");
      expect(getToolActionName("mcp_question", true)).toBe("Asked question");
    });

    test("should be case-insensitive for tool names", () => {
      expect(getToolActionName("READ", false)).toBe("Reading");
      expect(getToolActionName("Read", false)).toBe("Reading");
      expect(getToolActionName("rEaD", false)).toBe("Reading");
    });

    test("should generate gerund for unknown tools (running)", () => {
      expect(getToolActionName("fetch", false)).toBe("Fetching");
      expect(getToolActionName("compile", false)).toBe("Compiling");
      expect(getToolActionName("run", false)).toBe("Running");
    });

    test("should capitalize unknown tools (completed)", () => {
      expect(getToolActionName("fetch", true)).toBe("Fetch");
      expect(getToolActionName("compile", true)).toBe("Compile");
      expect(getToolActionName("customTool", true)).toBe("CustomTool");
    });

    test("should handle edge cases for gerund generation", () => {
      // Words ending in 'e' should drop the 'e'
      expect(getToolActionName("make", false)).toBe("Making");
      expect(getToolActionName("create", false)).toBe("Creating");

      // Words ending in 'ee' should not drop the 'e'
      expect(getToolActionName("see", false)).toBe("Seeing");

      // Words with consonant-vowel-consonant should double the final consonant
      expect(getToolActionName("run", false)).toBe("Running");
      expect(getToolActionName("get", false)).toBe("Getting");
    });
  });

  describe("extractParameter", () => {
    test("should extract filePath for file operations", () => {
      expect(extractParameter("read", { filePath: "/src/file.ts" })).toBe(
        "/src/file.ts",
      );
      expect(extractParameter("edit", { filePath: "/src/file.ts" })).toBe(
        "/src/file.ts",
      );
      expect(extractParameter("write", { filePath: "/src/file.ts" })).toBe(
        "/src/file.ts",
      );
    });

    test("should fallback to path if filePath not present", () => {
      expect(extractParameter("read", { path: "/src/file.ts" })).toBe(
        "/src/file.ts",
      );
    });

    test("should return 'file' if no path available for file operations", () => {
      expect(extractParameter("read", {})).toBe("file");
      expect(extractParameter("read", { other: "value" })).toBe("file");
    });

    test("should extract command for bash", () => {
      expect(extractParameter("bash", { command: "npm install" })).toBe(
        "npm install",
      );
      expect(extractParameter("bash", {})).toBe("command");
    });

    test("should extract pattern for glob and grep", () => {
      expect(extractParameter("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
      expect(extractParameter("grep", { pattern: "TODO" })).toBe("TODO");
      expect(extractParameter("glob", {})).toBe("pattern");
    });

    test("should extract description for task", () => {
      expect(extractParameter("task", { description: "Run tests" })).toBe(
        "Run tests",
      );
      expect(extractParameter("task", {})).toBe("task");
    });

    test("should extract question text for question tool", () => {
      expect(
        extractParameter("question", {
          questions: [{ question: "Which option?" }],
        }),
      ).toBe("Which option?");
    });

    test("should truncate long question text", () => {
      const longQuestion = "a".repeat(150);
      const result = extractParameter("question", {
        questions: [{ question: longQuestion }],
      });
      expect(result.length).toBe(100);
    });

    test("should return 'user input' if no valid question", () => {
      expect(extractParameter("question", {})).toBe("user input");
      expect(extractParameter("question", { questions: [] })).toBe(
        "user input",
      );
      expect(extractParameter("question", { questions: [{}] })).toBe(
        "user input",
      );
    });

    test("should extract first string value for unknown tools", () => {
      expect(extractParameter("customTool", { someParam: "value123" })).toBe(
        "value123",
      );
    });

    test("should truncate long values for unknown tools", () => {
      const longValue = "x".repeat(150);
      const result = extractParameter("customTool", { param: longValue });
      expect(result.length).toBe(100);
    });

    test("should return tool name if no extractable parameter", () => {
      expect(extractParameter("customTool", {})).toBe("customTool");
      expect(extractParameter("customTool", { count: 42 })).toBe("customTool");
    });

    test("should be case-insensitive for tool names", () => {
      expect(extractParameter("READ", { filePath: "/file.ts" })).toBe(
        "/file.ts",
      );
      expect(extractParameter("BASH", { command: "ls" })).toBe("ls");
    });

    test("should convert absolute paths to relative when workdir is provided", () => {
      const workdir = "/home/user/project";
      expect(
        extractParameter(
          "read",
          { filePath: "/home/user/project/src/file.ts" },
          workdir,
        ),
      ).toBe("src/file.ts");
      expect(
        extractParameter(
          "edit",
          { filePath: "/home/user/project/package.json" },
          workdir,
        ),
      ).toBe("package.json");
    });

    test("should handle worktree paths without explicit workdir", () => {
      expect(
        extractParameter("read", {
          filePath:
            "/Users/jack/.local/share/opencode/worktree/abc123/code-5/packages/core/test/time.test.ts",
        }),
      ).toBe("packages/core/test/time.test.ts");
    });

    test("should return original path if not under workdir", () => {
      const workdir = "/home/user/project";
      expect(
        extractParameter("read", { filePath: "/other/path/file.ts" }, workdir),
      ).toBe("/other/path/file.ts");
    });

    test("should handle path exactly at workdir root", () => {
      const workdir = "/home/user/project";
      expect(
        extractParameter("read", { filePath: "/home/user/project" }, workdir),
      ).toBe("/home/user/project");
    });
  });

  describe("truncate", () => {
    test("should not truncate short text", () => {
      expect(truncate("short text")).toBe("short text");
      expect(truncate("a".repeat(500))).toBe("a".repeat(500));
    });

    test("should truncate text longer than 500 characters", () => {
      const longText = "x".repeat(600);
      const result = truncate(longText);
      expect(result).toBe("x".repeat(500) + "...(truncated)");
      expect(result.length).toBe(514); // 500 + "...(truncated)".length
    });

    test("should not truncate text exactly at limit", () => {
      const text = "x".repeat(500);
      expect(truncate(text)).toBe(text);
    });

    test("should truncate text at limit + 1", () => {
      const text = "x".repeat(501);
      expect(truncate(text)).toBe("x".repeat(500) + "...(truncated)");
    });

    test("should handle empty string", () => {
      expect(truncate("")).toBe("");
    });
  });

  describe("mapTodoStatus", () => {
    test("should map 'pending' to 'pending'", () => {
      expect(mapTodoStatus("pending")).toBe("pending");
    });

    test("should map 'in_progress' to 'inProgress'", () => {
      expect(mapTodoStatus("in_progress")).toBe("inProgress");
    });

    test("should map 'completed' to 'completed'", () => {
      expect(mapTodoStatus("completed")).toBe("completed");
    });

    test("should map 'cancelled' to 'canceled'", () => {
      expect(mapTodoStatus("cancelled")).toBe("canceled");
    });

    test("should map unknown status to 'pending'", () => {
      expect(mapTodoStatus("unknown")).toBe("pending");
      expect(mapTodoStatus("")).toBe("pending");
      expect(mapTodoStatus("blocked")).toBe("pending");
    });
  });

  describe("getToolThought", () => {
    test("should return thought for bash test commands", () => {
      expect(getToolThought("bash", { command: "npm test" })).toBe(
        "Running tests to verify changes...",
      );
      expect(getToolThought("bash", { command: "bun run check" })).toBe(
        "Running tests to verify changes...",
      );
      expect(
        getToolThought("bash", { command: "bun test src/utils.test.ts" }),
      ).toBe("Running tests to verify changes...");
    });

    test("should return thought for bash git commands", () => {
      expect(getToolThought("bash", { command: "git commit -m 'fix'" })).toBe(
        "Committing changes...",
      );
      expect(getToolThought("bash", { command: "git push origin main" })).toBe(
        "Pushing changes to remote...",
      );
    });

    test("should return thought for bash PR creation", () => {
      expect(
        getToolThought("bash", { command: "gh pr create --title 'Fix'" }),
      ).toBe("Creating pull request...");
    });

    test("should return thought for bash install commands", () => {
      expect(getToolThought("bash", { command: "npm install" })).toBe(
        "Installing dependencies...",
      );
      expect(getToolThought("bash", { command: "bun install" })).toBe(
        "Installing dependencies...",
      );
    });

    test("should return null for generic bash commands", () => {
      expect(getToolThought("bash", { command: "ls -la" })).toBeNull();
      expect(getToolThought("bash", { command: "cat file.txt" })).toBeNull();
    });

    test("should return thought for grep", () => {
      expect(getToolThought("grep", { pattern: "TODO" })).toBe(
        "Searching codebase...",
      );
    });

    test("should return thought for glob", () => {
      expect(getToolThought("glob", { pattern: "**/*.ts" })).toBe(
        "Finding relevant files...",
      );
    });

    test("should return thought for task", () => {
      expect(getToolThought("task", { description: "Do something" })).toBe(
        "Delegating subtask...",
      );
    });

    test("should return null for other tools", () => {
      expect(getToolThought("read", { filePath: "/file.ts" })).toBeNull();
      expect(getToolThought("edit", { filePath: "/file.ts" })).toBeNull();
      expect(getToolThought("write", { filePath: "/file.ts" })).toBeNull();
    });

    test("should be case-insensitive for tool names", () => {
      expect(getToolThought("GREP", { pattern: "x" })).toBe(
        "Searching codebase...",
      );
      expect(getToolThought("Glob", { pattern: "x" })).toBe(
        "Finding relevant files...",
      );
      expect(getToolThought("TASK", { description: "x" })).toBe(
        "Delegating subtask...",
      );
    });

    test("should handle missing command for bash", () => {
      expect(getToolThought("bash", {})).toBeNull();
      expect(getToolThought("bash", { command: "" })).toBeNull();
    });
  });
});
