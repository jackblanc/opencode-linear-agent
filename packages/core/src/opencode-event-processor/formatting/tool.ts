/**
 * Tool name mapping for friendly action names
 */
const TOOL_ACTION_MAP: Record<string, { action: string; pastTense: string }> = {
  read: { action: "Reading", pastTense: "Read" },
  edit: { action: "Editing", pastTense: "Edited" },
  write: { action: "Creating", pastTense: "Created" },
  bash: { action: "Running", pastTense: "Ran" },
  glob: { action: "Searching files", pastTense: "Searched files" },
  grep: { action: "Searching code", pastTense: "Searched code" },
  task: { action: "Delegating task", pastTense: "Delegated task" },
  todowrite: { action: "Updating plan", pastTense: "Updated plan" },
  todoread: { action: "Reading plan", pastTense: "Read plan" },
  question: { action: "Asking question", pastTense: "Asked question" },
  mcp_question: { action: "Asking question", pastTense: "Asked question" },
};

/**
 * Maximum length for tool output before truncation
 */
const MAX_OUTPUT_LENGTH = 500;

/**
 * Convert a verb to its gerund (-ing) form with proper English rules.
 * Handles consonant doubling (run→running), silent-e dropping (make→making),
 * and special endings (see→seeing).
 */
function toGerund(verb: string): string {
  const lower = verb.toLowerCase();
  if (lower.endsWith("e") && !lower.endsWith("ee")) {
    return verb.slice(0, -1) + "ing";
  }
  const len = lower.length;
  if (len >= 3) {
    const last = lower.charAt(len - 1);
    const secondLast = lower.charAt(len - 2);
    const thirdLast = lower.charAt(len - 3);
    const vowels = "aeiou";
    const noDouble = "wxy";
    if (
      !vowels.includes(last) &&
      !noDouble.includes(last) &&
      vowels.includes(secondLast) &&
      !vowels.includes(thirdLast)
    ) {
      return verb + last + "ing";
    }
  }
  return verb + "ing";
}

/**
 * Get friendly tool action name
 */
export function getToolActionName(
  toolName: string,
  completed: boolean,
): string {
  const mapping = TOOL_ACTION_MAP[toolName.toLowerCase()];
  if (!mapping) {
    const capitalized = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    return completed ? capitalized : toGerund(capitalized);
  }
  return completed ? mapping.pastTense : mapping.action;
}

/**
 * Safely extract a string from an unknown input object
 */
function getString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

/**
 * Convert an absolute path to a relative path from workdir
 * Makes logs more readable by removing the long worktree prefix
 */
function toRelativePath(absolutePath: string, workdir: string | null): string {
  if (!workdir || !absolutePath.startsWith(workdir)) {
    // If no workdir or path doesn't start with it, try to extract just the repo-relative part
    // Worktree paths look like: /home/user/.local/share/opencode/worktree/<hash>/<issue-slug>/...
    const worktreeMatch = absolutePath.match(/\/worktree\/[^/]+\/[^/]+\/(.+)$/);
    if (worktreeMatch?.[1]) {
      return worktreeMatch[1];
    }
    return absolutePath;
  }

  // Remove workdir prefix and leading slash
  let relative = absolutePath.slice(workdir.length);
  if (relative.startsWith("/")) {
    relative = relative.slice(1);
  }
  return relative || absolutePath;
}

/**
 * Replace all absolute paths in a string with relative paths
 * Handles tool output that may contain multiple file paths
 */
export function replacePathsInOutput(
  output: string,
  workdir: string | null,
): string {
  if (!workdir) {
    // Try worktree pattern replacement even without explicit workdir
    return output.replace(
      /\/[^\s:]+\/\.local\/share\/opencode\/worktree\/[^/]+\/[^/]+\/([^\s:]+)/g,
      "$1",
    );
  }

  // Escape special regex chars in workdir for use in pattern
  const escapedWorkdir = workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Match workdir followed by path characters (not whitespace or common delimiters)
  const pattern = new RegExp(`${escapedWorkdir}/?([^\\s:]+)`, "g");

  return output.replace(pattern, "$1");
}

/**
 * Extract parameter from tool input for display
 */
export function extractToolParameter(
  toolName: string,
  input: Record<string, unknown>,
  workdir: string | null = null,
): string {
  const key = toolName.toLowerCase();
  switch (key) {
    case "read":
    case "edit":
    case "write": {
      const filePath =
        getString(input, "filePath") ?? getString(input, "path") ?? "file";
      return toRelativePath(filePath, workdir);
    }
    case "bash":
      return getString(input, "command") ?? "command";
    case "glob":
    case "grep":
      return getString(input, "pattern") ?? "pattern";
    case "task":
      return getString(input, "description") ?? "task";
    case "question": {
      // Extract question text from the questions array
      const questions = input["questions"];
      if (Array.isArray(questions) && questions.length > 0) {
        const first = questions[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "question" in first &&
          typeof first.question === "string"
        ) {
          return first.question.slice(0, 100);
        }
      }
      return "user input";
    }
    default: {
      const firstKey = Object.keys(input)[0];
      if (firstKey) {
        const value = input[firstKey];
        // Handle arrays and objects gracefully - don't stringify them directly
        if (
          Array.isArray(value) ||
          (typeof value === "object" && value !== null)
        ) {
          return toolName;
        }
        return String(value).slice(0, 100);
      }
      return toolName;
    }
  }
}

/**
 * Truncate output if it exceeds max length
 */
export function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + "...(truncated)";
  }
  return output;
}

/**
 * Get contextual thought message for tool execution
 */
export function getToolThought(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const toolLower = toolName.toLowerCase();
  const command = getString(input, "command");

  // Bash commands
  if (toolLower === "bash" && command) {
    if (command.includes("test") || command.includes("bun run check")) {
      return "Running tests to verify changes...";
    }
    if (command.includes("gh pr create")) {
      return "Creating pull request...";
    }
    if (command.includes("git commit")) {
      return "Committing changes...";
    }
    if (command.includes("git push")) {
      return "Pushing changes to remote...";
    }
  }

  // Search operations
  if (toolLower === "grep") {
    return "Searching codebase...";
  }

  if (toolLower === "glob") {
    return "Finding relevant files...";
  }

  // Task delegation
  if (toolLower === "task") {
    return "Delegating subtask...";
  }
}
