import type { Part } from "@opencode-ai/sdk";
import type { LinearService } from "@linear-opencode-agent/core";
import { Result } from "better-result";
import { getSessionAsync } from "./storage";

export type Logger = (message: string) => void;

export type TokenReader = (organizationId: string) => Promise<string | null>;

export type LinearServiceFactory = (accessToken: string) => LinearService;

const postedMessages = new Set<string>();
const postingMessages = new Set<string>();

function getPostedKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

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
  sessionId: string,
  messageId: string | undefined,
  parts: Part[],
  readToken: TokenReader,
  createService: LinearServiceFactory,
  log: Logger,
): Promise<void> {
  let key: string | undefined;
  if (messageId) {
    key = getPostedKey(sessionId, messageId);
    if (postedMessages.has(key) || postingMessages.has(key)) return;
    postingMessages.add(key);
  }

  try {
    const text = extractUserText(parts);
    if (!text) return;

    const session = await getSessionAsync(sessionId);
    if (!session?.linear.sessionId) return;

    const token = await readToken(session.linear.organizationId);
    if (!token) return;

    const linear = createService(token);
    const result = await linear.postActivity(session.linear.sessionId, {
      type: "thought",
      body: `User: ${text}`,
    });
    if (Result.isError(result)) {
      log("chat.message: failed to post user message to Linear");
      return;
    }

    if (key) {
      postedMessages.add(key);
    }
  } finally {
    if (key) {
      postingMessages.delete(key);
    }
  }
}
