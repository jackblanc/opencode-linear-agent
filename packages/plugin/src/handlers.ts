import type { Part } from "@opencode-ai/sdk/v2";
import type { LinearService } from "@opencode-linear-agent/core";
import { Result } from "better-result";
import { getSessionAsync } from "./storage";

export type Logger = (message: string) => void;

export type TokenReader = (organizationId: string) => Promise<string | null>;

export type LinearServiceFactory = (accessToken: string) => LinearService;

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text";
}

function stripFrontmatter(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("---\n")) return trimmed;

  const lines = trimmed.split("\n");
  if (lines[0] !== "---") return trimmed;

  let i = 1;
  while (i < lines.length) {
    if (lines[i] === "---") {
      return lines
        .slice(i + 1)
        .join("\n")
        .trim();
    }
    i += 1;
  }

  return trimmed;
}

function extractUserText(parts: Part[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isTextPart(part)) continue;
    texts.push(part.text);
  }
  if (texts.length === 0) return "";
  return stripFrontmatter(texts.join("\n")).trim();
}

export async function handleUserMessage(
  workdir: string,
  parts: Part[],
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  const text = extractUserText(parts);
  if (!text) return;

  const session = await getSessionAsync(workdir);
  if (!session?.sessionId) return;

  const token = await readToken(session.organizationId);
  if (!token) return;

  const linear = createService(token);
  const result = await linear.postActivity(session.sessionId, {
    type: "thought",
    body: `User: ${text}`,
  });
  if (Result.isError(result)) {
    log("chat.message: failed to post user message to Linear");
  }
}
