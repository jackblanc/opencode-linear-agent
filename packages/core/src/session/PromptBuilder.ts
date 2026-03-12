import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type {
  LinearIssue,
  LinearIssueRelation,
  LinearIssueRelations,
} from "../linear/LinearService";
import type { AgentMode } from "./AgentMode";

export interface PromptContext {
  linearSessionId: string;
  organizationId: string;
  workdir: string;
}

function buildFrontmatter(issueId: string, ctx: PromptContext): string {
  return `---
linear_session: ${ctx.linearSessionId}
linear_issue: ${issueId}
linear_organization: ${ctx.organizationId}
workdir: ${ctx.workdir}
---`;
}

const BUILD_MODE_INSTRUCTIONS = `## Build Mode

You are in BUILD MODE.

- Treat the latest user directive as the highest-priority instruction. It can narrow, question, or override earlier issue framing.
- Default to the smallest change that resolves the request. Avoid speculative cleanup, refactors, or extra abstractions.
- If the latest user message is asking whether work is worth doing, answer that first. Do not implement unless the user clearly wants implementation.
- When work is complete, push the current branch. Create a PR only when the user asks or review clearly needs one.`;

const PLAN_MODE_INSTRUCTIONS = `## Plan Mode

You are in PLAN MODE. Investigate and update the Linear issue with one concise unified plan. Do not implement.

- Overwrite prior agent-written plan text instead of appending another full plan.
- Preserve user intent from the existing description and comments, but rewrite it into one short precise plan.
- Keep the plan conceptual and brief. Do not list file paths unless truly necessary.
- Remove stale or duplicated plan content when updating the issue.
- Treat the latest user directive as highest priority if it narrows or reframes the work.
- Do not create code changes, commits, branches, or pull requests.`;

function getInstructionsForMode(mode: AgentMode): string {
  return mode === "plan" ? PLAN_MODE_INSTRUCTIONS : BUILD_MODE_INSTRUCTIONS;
}

function compactMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}

function extractPrimaryDirective(promptContext: unknown): string | null {
  if (typeof promptContext !== "string") {
    return null;
  }

  const match = promptContext.match(
    /<primary-directive-thread\b[^>]*>([\s\S]*?)<\/primary-directive-thread>/i,
  );
  const body = match?.[1];
  if (!body) {
    return null;
  }

  const text = compactMarkdown(stripTags(body).replace(/\s+/g, " "));
  return text.length > 0 ? text : null;
}

function buildRelationGroup(
  label: string,
  items: LinearIssueRelation[],
): string[] {
  if (items.length === 0) {
    return [];
  }

  return items.map((item, i) =>
    i === 0
      ? `- ${label}: ${item.identifier} - ${item.title}`
      : `- ${item.identifier} - ${item.title}`,
  );
}

function buildRelations(relations?: LinearIssueRelations): string {
  if (!relations) {
    return "";
  }

  const lines = [
    ...buildRelationGroup("Related", relations.related),
    ...buildRelationGroup("Blocks", relations.blocks),
    ...buildRelationGroup("Blocked by", relations.blockedBy),
    ...buildRelationGroup("Duplicate", relations.duplicate),
  ];

  if (lines.length === 0) {
    return "";
  }

  return `## Related Issues\n\n${lines.join("\n")}`;
}

function resolveIssue(
  event: AgentSessionEventWebhookPayload,
  issue?: LinearIssue,
): LinearIssue | null {
  if (issue) {
    return issue;
  }

  const current = event.agentSession.issue;
  if (!current) {
    return null;
  }

  return {
    id: current.id,
    identifier: current.identifier,
    title: current.title,
    url: current.url,
  };
}

function buildIssueSummary(issue: LinearIssue | null): string {
  if (!issue) {
    return "";
  }

  const parts = [
    "# Issue",
    "",
    `- ${issue.identifier}: ${issue.title}`,
    `- URL: ${issue.url}`,
  ];

  const desc = issue.description ? compactMarkdown(issue.description) : "";
  if (desc) {
    parts.push("", "## Description", "", desc);
  }

  const relations = buildRelations(issue.relations);
  if (relations) {
    parts.push("", relations);
  }

  return parts.join("\n");
}

function buildLatestDirective(text: string): string {
  return `## Latest User Directive\n\n${text}`;
}

function joinSections(parts: Array<string | undefined>): string {
  return parts
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n\n");
}

export class PromptBuilder {
  buildCreatedPrompt(
    event: AgentSessionEventWebhookPayload,
    ctx: PromptContext,
    mode: AgentMode,
    issue?: LinearIssue,
    previousContext?: string,
  ): string {
    const issueId = event.agentSession.issue?.identifier ?? "unknown";
    const directive =
      extractPrimaryDirective(event.promptContext) ??
      "Please help with this issue.";

    return joinSections([
      buildFrontmatter(issueId, ctx),
      getInstructionsForMode(mode),
      buildIssueSummary(resolveIssue(event, issue)),
      previousContext,
      buildLatestDirective(directive),
    ]);
  }

  buildFollowUpPrompt(
    event: AgentSessionEventWebhookPayload,
    userResponse: string,
    ctx: PromptContext,
    mode: AgentMode,
    issue?: LinearIssue,
    previousContext?: string,
  ): string {
    if (!previousContext) {
      return userResponse;
    }

    const issueId = event.agentSession.issue?.identifier ?? "unknown";
    return joinSections([
      buildFrontmatter(issueId, ctx),
      getInstructionsForMode(mode),
      buildIssueSummary(resolveIssue(event, issue)),
      previousContext,
      buildLatestDirective(userResponse),
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
      buildFrontmatter(issueId, ctx),
      getInstructionsForMode(mode),
      previousContext,
      buildLatestDirective(userResponse),
    ]);
  }
}
