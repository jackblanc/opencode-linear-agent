import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { AgentMode } from "./AgentMode";

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
    event.promptContext.trim().length > 0
  ) {
    return event.promptContext;
  }

  return `Please help with this issue: ${event.agentSession.issueId}`;
}

function joinSections(parts: string[]): string {
  return parts.join("\n\n");
}

export function buildCreatedPrompt(
  event: AgentSessionEventWebhookPayload,
  mode: AgentMode,
): string {
  return joinSections([getSystemDirective(mode), readPromptContext(event)]);
}
