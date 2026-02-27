import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { AgentMode } from "./AgentMode";

/**
 * Context for building prompts with Linear integration
 */
export interface PromptContext {
  linearSessionId: string;
  organizationId: string;
  workdir: string;
}

/**
 * Build YAML frontmatter for the plugin to parse
 */
function buildFrontmatter(issueId: string, ctx: PromptContext): string {
  return `---
linear_session: ${ctx.linearSessionId}
linear_issue: ${issueId}
linear_organization: ${ctx.organizationId}
workdir: ${ctx.workdir}
---

`;
}

/**
 * Build mode instructions - agent implements the issue and creates a PR
 */
const BUILD_MODE_INSTRUCTIONS = `
## Important: Always Create a Pull Request

When you complete work on an issue, you MUST create a pull request. Follow these rules:

1. **Always push your changes and create a PR** when the work is complete
2. **If you're uncertain** about the implementation or need clarification, ask the user BEFORE pushing - but still plan to create a PR after getting answers
3. **Never say "done" or "completed"** without having created and pushed a PR
4. Use \`gh pr create\` to create the pull request with a clear title and description

The PR is how your work gets reviewed and merged. An issue is not complete until there's a PR.

---

`;

/**
 * Plan mode instructions - agent analyzes issue and writes implementation plan
 */
const PLAN_MODE_INSTRUCTIONS = `
## Important: Write an Implementation Plan

You are in PLANNING MODE. Analyze this issue and write a detailed implementation plan - do NOT implement it.

### Your Tasks:
1. Analyze the issue requirements and explore the codebase
2. Write a clear, actionable implementation plan
3. Update the issue using Linear MCP tools:
   - Append your plan to the description (preserve existing content)
   - Set priority if not already set
   - Add \`repo:*\` label if missing

### Do NOT:
- Create any code changes, branches, or commits
- Create pull requests
- Move the issue to a different status

### Plan Format:
Append to the issue description with this structure:

---

## Implementation Plan

### Summary
1-2 sentences describing the change

### Files to Modify
- \`path/to/file.ts\` - Brief description of changes

### Implementation Steps
1. Step one
2. Step two
...

### Edge Cases
- Potential issues to watch for

### Testing
- How to verify the change works

---

Once you've written the plan and updated the issue, you're done.

---

`;

/**
 * Get the appropriate instructions for the given agent mode
 */
function getInstructionsForMode(mode: AgentMode): string {
  return mode === "plan" ? PLAN_MODE_INSTRUCTIONS : BUILD_MODE_INSTRUCTIONS;
}

/**
 * Remove previous session threads from Linear promptContext.
 */
function stripOtherThreads(promptContext: string): string {
  return promptContext.replace(
    /<other-thread[^>]*>[\s\S]*?<\/other-thread>/g,
    "",
  );
}

/**
 * Builds prompts for OpenCode sessions.
 *
 * Extracted from LinearEventProcessor to isolate prompt construction logic:
 * - Building issue context headers
 * - Injecting system instructions
 * - Combining previous context with new prompts
 */
export class PromptBuilder {
  /**
   * Build issue context header from webhook payload
   */
  buildIssueContext(event: AgentSessionEventWebhookPayload): string {
    const issue = event.agentSession.issue;
    if (!issue) {
      return "";
    }

    const parts: string[] = [
      `# Linear Issue: ${issue.identifier}`,
      "",
      `**Title:** ${issue.title}`,
    ];

    if (issue.url) {
      parts.push(`**URL:** ${issue.url}`);
    }

    parts.push("", "---", "");

    return parts.join("\n");
  }

  /**
   * Build prompt for new session creation
   *
   * @param event - The webhook payload
   * @param ctx - Context for Linear integration (session, org, paths)
   * @param mode - The agent mode (plan or build)
   * @param previousContext - Optional context from a previous session
   * @returns The complete prompt with frontmatter, system instructions and context
   */
  buildCreatedPrompt(
    event: AgentSessionEventWebhookPayload,
    ctx: PromptContext,
    mode: AgentMode,
    previousContext?: string,
  ): string {
    const issueId = event.agentSession.issue?.identifier ?? "unknown";
    const frontmatter = buildFrontmatter(issueId, ctx);
    const instructions = getInstructionsForMode(mode);
    const issueContext = this.buildIssueContext(event);
    const rawPrompt = event.promptContext ?? "Please help with this issue.";
    const filteredPrompt = stripOtherThreads(rawPrompt).trim();
    const basePrompt = filteredPrompt || "Please help with this issue.";
    return `${frontmatter}${instructions}${issueContext}${previousContext ?? ""}${basePrompt}`;
  }

  /**
   * Build prompt for follow-up message
   *
   * If session was recreated (has previousContext), inject frontmatter, system instructions
   * and issue context. Otherwise, just use the user response (frontmatter already in session).
   *
   * @param event - The webhook payload
   * @param userResponse - The user's follow-up message
   * @param ctx - Context for Linear integration
   * @param mode - The agent mode (plan or build)
   * @param previousContext - Optional context from a previous session
   * @returns The prompt to send
   */
  buildFollowUpPrompt(
    event: AgentSessionEventWebhookPayload,
    userResponse: string,
    ctx: PromptContext,
    mode: AgentMode,
    previousContext?: string,
  ): string {
    if (previousContext) {
      const issueId = event.agentSession.issue?.identifier ?? "unknown";
      const frontmatter = buildFrontmatter(issueId, ctx);
      const instructions = getInstructionsForMode(mode);
      const issueContext = this.buildIssueContext(event);
      return `${frontmatter}${instructions}${issueContext}${previousContext}${userResponse}`;
    }
    return userResponse;
  }

  /**
   * Build prompt for follow-up when ignoring a pending question
   *
   * @param userResponse - The user's message
   * @param issueId - The issue identifier (e.g., "CODE-123")
   * @param ctx - Context for Linear integration
   * @param mode - The agent mode (plan or build)
   * @param previousContext - Optional context from a previous session
   * @returns The prompt to send
   */
  buildFollowUpWithoutEvent(
    userResponse: string,
    issueId: string,
    ctx: PromptContext,
    mode: AgentMode,
    previousContext?: string,
  ): string {
    if (previousContext) {
      const frontmatter = buildFrontmatter(issueId, ctx);
      const instructions = getInstructionsForMode(mode);
      return `${frontmatter}${instructions}${previousContext}${userResponse}`;
    }
    return userResponse;
  }
}
