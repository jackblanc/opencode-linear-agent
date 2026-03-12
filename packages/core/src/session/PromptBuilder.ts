import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { AgentMode } from "./AgentMode";

export interface PromptContext {
  linearSessionId: string;
  organizationId: string;
  workdir: string;
}

// TODO (CODE-244): Remove this, replace with a more robust system for tracking session and issue context across prompt interactions
function getFrontmatter(issueId: string, ctx: PromptContext): string {
  return `---
linear_session: ${ctx.linearSessionId}
linear_issue: ${issueId}
linear_organization: ${ctx.organizationId}
workdir: ${ctx.workdir}
---`;
}

function getSystemDirective(mode: AgentMode): string {
  if (mode === "plan") {
    return `<system-reminder>
Your operational mode is plan.
You are in read-only mode.
Do not make file changes, run write commands, or change git state.
</system-reminder>`;
  }

  return `<system-reminder>
Your operational mode is build.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>`;
}

function readPromptContext(event: AgentSessionEventWebhookPayload): string {
  if (
    typeof event.promptContext === "string" &&
    event.promptContext.length > 0
  ) {
    return event.promptContext;
  }

  return "Please help with this issue.";
}

function joinSections(parts: string[]): string {
  return parts.join("\n\n");
}

export class PromptBuilder {
  buildCreatedPrompt(
    event: AgentSessionEventWebhookPayload,
    ctx: PromptContext,
    mode: AgentMode,
    previousContext?: string,
  ): string {
    const issueId = event.agentSession.issue?.identifier ?? "unknown";

    return joinSections([
      getFrontmatter(issueId, ctx),
      getSystemDirective(mode),
      ...(previousContext ? [previousContext] : []),
      readPromptContext(event),
    ]);
  }

  buildFollowUpPrompt(
    event: AgentSessionEventWebhookPayload,
    userResponse: string,
    ctx: PromptContext,
    mode: AgentMode,
    previousContext?: string,
  ): string {
    if (!previousContext) {
      return userResponse;
    }

    const issueId = event.agentSession.issue?.identifier ?? "unknown";

    return joinSections([
      getFrontmatter(issueId, ctx),
      getSystemDirective(mode),
      previousContext,
      userResponse,
    ]);
  }

  buildFollowUpWithoutEvent(
    userResponse: string,
    issueId: string,
    ctx: PromptContext,
    mode: AgentMode,
    previousContext?: string,
  ): string {
    if (!previousContext) {
      return userResponse;
    }

    return joinSections([
      getFrontmatter(issueId, ctx),
      getSystemDirective(mode),
      previousContext,
      userResponse,
    ]);
  }
}
