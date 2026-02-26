import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  getChatMessageId,
  getChatMessageSessionId,
  getChatMessageText,
  handleUserMessage,
  type LinearActivityClient,
} from "../src/handlers";

describe("chat message handlers", () => {
  test("extracts and strips frontmatter from top-level message", () => {
    const text = getChatMessageText({
      message: {
        text: "---\nlinear_session: abc\n---\n\nfollow-up question",
      },
    });

    expect(text).toBe("follow-up question");
  });

  test("returns null for frontmatter-only message", () => {
    const text = getChatMessageText({
      message: {
        text: "---\nlinear_session: abc\n---\n",
      },
    });

    expect(text).toBeNull();
  });

  test("extracts latest user message from message history", () => {
    const text = getChatMessageText({
      messages: [
        { role: "assistant", text: "hello" },
        { role: "user", parts: [{ type: "text", text: "please retry" }] },
      ],
    });

    expect(text).toBe("please retry");
  });

  test("extracts session and message ids", () => {
    const sessionId = getChatMessageSessionId({ sessionID: "sess-1" });
    const nestedSessionId = getChatMessageSessionId({
      session: { id: "sess-2" },
    });
    const messageId = getChatMessageId({ message: { id: "msg-1" } });

    expect(sessionId).toBe("sess-1");
    expect(nestedSessionId).toBe("sess-2");
    expect(messageId).toBe("msg-1");
  });

  test("posts user message as thought activity", async () => {
    const posts: Array<{ sessionId: string; body: string }> = [];
    const client: LinearActivityClient = {
      postActivity: async (sessionId, content) => {
        if (content.type === "thought" && content.body) {
          posts.push({ sessionId, body: content.body });
        }
        return Result.ok(undefined);
      },
    };

    const logs: string[] = [];
    await handleUserMessage("linear-1", "need more logs", client, (msg) => {
      logs.push(msg);
    });

    expect(posts).toEqual([
      {
        sessionId: "linear-1",
        body: "User: need more logs",
      },
    ]);
    expect(logs).toHaveLength(0);
  });
});
