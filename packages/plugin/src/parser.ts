/**
 * YAML frontmatter parser for extracting Linear context from messages.
 *
 * Expected format:
 * ---
 * linear_session: ses_abc123
 * linear_issue: CODE-42
 * linear_organization: org_xyz
 * store_path: /path/to/store.json
 * workdir: /path/to/workdir
 * ---
 */

import { parse as parseYaml } from "yaml";
import { Result } from "better-result";

/**
 * Linear context extracted from frontmatter.
 */
export interface LinearContext {
  sessionId: string | null;
  issueId: string;
  organizationId: string;
  storePath: string;
  workdir: string;
}

/**
 * Result of parsing frontmatter from a message
 */
export interface ParseResult {
  context: LinearContext | null;
  text: string;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseYaml(yaml: string): unknown {
  const result = Result.try({
    try: () => parseYaml(yaml) as unknown,
    catch: () => null,
  });
  return result.status === "ok" ? result.value : null;
}

/**
 * Parse YAML frontmatter from message text to extract Linear context.
 */
export function parseFrontmatter(text: string): ParseResult {
  const match = FRONTMATTER_REGEX.exec(text);

  if (!match?.[1]) {
    return { context: null, text };
  }

  const parsed = safeParseYaml(match[1]);

  if (!isRecord(parsed)) {
    return { context: null, text };
  }

  const sessionId = parsed["linear_session"];
  const issueId = parsed["linear_issue"];
  const organizationId = parsed["linear_organization"];
  const storePath = parsed["store_path"];
  const workdir = parsed["workdir"];

  // Required fields
  if (typeof issueId !== "string") return { context: null, text };
  if (typeof organizationId !== "string") return { context: null, text };
  if (typeof storePath !== "string") return { context: null, text };
  if (typeof workdir !== "string") return { context: null, text };

  return {
    context: {
      sessionId: typeof sessionId === "string" ? sessionId : null,
      issueId,
      organizationId,
      storePath,
      workdir,
    },
    text,
  };
}
