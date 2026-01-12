import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";

/**
 * System instructions prepended to every agent prompt.
 * Ensures consistent behavior across all sessions.
 */
const SYSTEM_INSTRUCTIONS = `
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
 * Builds prompts for OpenCode sessions.
 *
 * Extracted from EventProcessor to isolate prompt construction logic:
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
   * @param previousContext - Optional context from a previous session
   * @returns The complete prompt with system instructions and context
   */
  buildCreatedPrompt(
    event: AgentSessionEventWebhookPayload,
    previousContext?: string,
  ): string {
    const issueContext = this.buildIssueContext(event);
    const basePrompt = event.promptContext ?? "Please help with this issue.";
    return `${SYSTEM_INSTRUCTIONS}${issueContext}${previousContext ?? ""}${basePrompt}`;
  }

  /**
   * Build prompt for follow-up message
   *
   * If session was recreated (has previousContext), inject system instructions
   * and issue context. Otherwise, just use the user response.
   *
   * @param event - The webhook payload
   * @param userResponse - The user's follow-up message
   * @param previousContext - Optional context from a previous session
   * @returns The prompt to send
   */
  buildFollowUpPrompt(
    event: AgentSessionEventWebhookPayload,
    userResponse: string,
    previousContext?: string,
  ): string {
    if (previousContext) {
      const issueContext = this.buildIssueContext(event);
      return `${SYSTEM_INSTRUCTIONS}${issueContext}${previousContext}${userResponse}`;
    }
    return userResponse;
  }

  /**
   * Build prompt for follow-up when ignoring a pending question
   *
   * @param userResponse - The user's message
   * @param previousContext - Optional context from a previous session
   * @returns The prompt to send
   */
  buildFollowUpWithoutEvent(
    userResponse: string,
    previousContext?: string,
  ): string {
    if (previousContext) {
      return `${SYSTEM_INSTRUCTIONS}${previousContext}${userResponse}`;
    }
    return userResponse;
  }
}
