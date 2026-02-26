import type { LinearService } from "@linear-opencode-agent/core";
import { Result } from "better-result";

export type Logger = (message: string) => void;
export type LinearActivityClient = Pick<LinearService, "postActivity">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function readTextParts(parts: unknown[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;

    const text = readString(part, "text");
    if (text && text.trim().length > 0) {
      out.push(text);
      continue;
    }

    const content = readString(part, "content");
    if (content && content.trim().length > 0) {
      out.push(content);
    }
  }

  if (out.length === 0) return null;
  return out.join("\n");
}

function readMessageText(msg: Record<string, unknown>): string | null {
  const text = readString(msg, "text");
  if (text) return text;

  const message = readString(msg, "message");
  if (message) return message;

  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const contentText = readTextParts(content);
    if (contentText) return contentText;
  }

  const parts = msg.parts;
  if (Array.isArray(parts)) {
    return readTextParts(parts);
  }

  return null;
}

function isUserMessage(msg: Record<string, unknown>): boolean {
  const role = readString(msg, "role");
  if (role === "user") return true;

  const source = readString(msg, "source");
  if (source === "user") return true;

  return false;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/);
  if (!match) return text;
  return text.slice(match[0].length);
}

function normalizeMessage(text: string | null): string | null {
  if (!text) return null;
  const normalized = stripFrontmatter(text).trim();
  if (normalized.length === 0) return null;
  return normalized;
}

export function getChatMessageSessionId(ctx: unknown): string | null {
  if (!isRecord(ctx)) return null;

  const top = readString(ctx, "sessionID");
  if (top) return top;

  const session = ctx.session;
  if (!isRecord(session)) return null;
  return readString(session, "id");
}

export function getChatMessageId(ctx: unknown): string | null {
  if (!isRecord(ctx)) return null;

  const top = readString(ctx, "id");
  if (top) return top;

  const message = ctx.message;
  if (!isRecord(message)) return null;
  return readString(message, "id");
}

export function getChatMessageText(ctx: unknown): string | null {
  if (!isRecord(ctx)) return null;

  const message = ctx.message;
  if (isRecord(message)) {
    const text = normalizeMessage(readMessageText(message));
    if (text) return text;
  }

  const messages = ctx.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i];
      if (!isRecord(item)) continue;
      if (!isUserMessage(item)) continue;
      const text = normalizeMessage(readMessageText(item));
      if (text) return text;
    }
  }

  return normalizeMessage(readMessageText(ctx));
}

export async function handleUserMessage(
  linearSessionId: string,
  message: string,
  linear: LinearActivityClient,
  log: Logger,
): Promise<void> {
  const result = await linear.postActivity(linearSessionId, {
    type: "thought",
    body: `User: ${message}`,
  });

  if (Result.isError(result)) {
    log(`Failed to post user message to Linear: ${result.error.message}`);
  }
}
