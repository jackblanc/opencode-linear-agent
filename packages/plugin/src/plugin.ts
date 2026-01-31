/**
 * OpenCode plugin for Linear integration.
 *
 * Streams OpenCode events to Linear issues as activities.
 * Reads OAuth token from shared store file (set by server).
 *
 * Linear context is extracted from YAML frontmatter in the first user message:
 * ---
 * linear_session: ses_abc123
 * linear_issue: CODE-42
 * linear_organization: org_xyz
 * store_path: /path/to/store.json
 * workdir: /path/to/workdir
 * ---
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { createLinearService } from "./linear/client";
import { readAccessToken } from "./storage";
import { parseFrontmatter } from "./parser";
import {
  initSession,
  getSession,
  storePendingQuestionArgs,
  consumePendingQuestionArgs,
} from "./state";
import {
  handleToolPart,
  handleTextPart,
  handleTodoUpdated,
  handleSessionIdle,
  handleSessionError,
  handlePermissionAsk,
  handleQuestionElicitation,
  type Logger,
} from "./handlers";
import { linearTools } from "./tools/index";

export async function LinearPlugin(input: PluginInput): Promise<Hooks> {
  const log: Logger = (message: string) => {
    void input.client.app.log({
      body: {
        service: "linear-plugin",
        level: "error",
        message,
      },
    });
  };

  const info = (message: string, extra?: Record<string, unknown>): void => {
    void input.client.app.log({
      body: {
        service: "linear-plugin",
        level: "info",
        message,
        extra,
      },
    });
  };

  const warn = (message: string, extra?: Record<string, unknown>): void => {
    void input.client.app.log({
      body: {
        service: "linear-plugin",
        level: "warn",
        message,
        extra,
      },
    });
  };

  info("Linear plugin initialized (token loaded per-session from store file)");

  return {
    tool: linearTools,

    /**
     * Hook into chat messages to extract Linear context and load token.
     */
    "chat.message": async (ctx, output) => {
      const textPart = output.parts.find((p) => p.type === "text");
      if (!textPart || textPart.type !== "text") return;

      const text = "text" in textPart ? textPart.text : "";
      const result = parseFrontmatter(text);

      if (!result.context) return;
      if (getSession(ctx.sessionID)) return;

      // Read token from shared store
      const token = await readAccessToken(result.context.organizationId);

      if (!token) {
        warn(
          `No token found in store for organization ${result.context.organizationId}`,
        );
        return;
      }

      const linear = createLinearService(token);

      // If no session ID provided, create a new Linear session
      if (!result.context.sessionId) {
        const issueResult = await linear.getIssueId(result.context.issueId);
        if (issueResult.status === "error") {
          log(
            `Failed to resolve issue ${result.context.issueId}: ${issueResult.error.message}`,
          );
          return;
        }

        const sessionResult = await linear.createSession(issueResult.value);
        if (sessionResult.status === "error") {
          log(
            `Failed to create Linear session for issue ${result.context.issueId}: ${sessionResult.error.message}`,
          );
          return;
        }

        const context = { ...result.context, sessionId: sessionResult.value };
        initSession(ctx.sessionID, context);

        info(`Created new Linear session for issue ${result.context.issueId}`, {
          linearSession: sessionResult.value,
          linearIssue: result.context.issueId,
        });
        return;
      }

      initSession(ctx.sessionID, result.context);

      info(`Session initialized for issue ${result.context.issueId}`, {
        linearSession: result.context.sessionId,
        linearIssue: result.context.issueId,
      });
    },

    /**
     * Event handler for streaming OpenCode events to Linear.
     */
    event: async ({ event }) => {
      // Get session to check if we have Linear context
      const props = event.properties as Record<string, unknown>;
      const sessionId =
        "sessionID" in props
          ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sessionID is string when present
            (props.sessionID as string)
          : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- part contains sessionID
            (props.part as { sessionID?: string } | undefined)?.sessionID;

      if (!sessionId) return;

      const session = getSession(sessionId);
      if (!session) return;

      // Load token for this session
      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      if (event.type === "message.part.updated") {
        await handleToolPart(event, linear, log);
        await handleTextPart(event, linear, log);
        return;
      }

      if (event.type === "todo.updated") {
        await handleTodoUpdated(event, linear, log);
        return;
      }

      if (event.type === "session.idle") {
        handleSessionIdle(event);
        return;
      }

      if (event.type === "session.error") {
        await handleSessionError(event, linear, log);
        return;
      }
    },

    /**
     * Hook into tool execution to capture question args for elicitations.
     */
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool.toLowerCase() === "question") {
        storePendingQuestionArgs(ctx.callID, output.args);
      }
    },

    /**
     * Hook into tool execution completion to post question elicitations.
     */
    "tool.execute.after": async (ctx, _output) => {
      if (ctx.tool.toLowerCase() !== "question") return;

      const args = consumePendingQuestionArgs(ctx.callID);
      if (!args) return;

      const session = getSession(ctx.sessionID);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      // Use callID as the requestId for question replies
      await handleQuestionElicitation(
        ctx.sessionID,
        ctx.callID,
        args,
        linear,
        log,
      );
    },

    /**
     * Hook into permission requests to post elicitations.
     */
    "permission.ask": async (ctx: Permission, _output) => {
      const session = getSession(ctx.sessionID);
      if (!session) return;

      const token = await readAccessToken(session.linear.organizationId);
      if (!token) return;

      const linear = createLinearService(token);

      const patterns = Array.isArray(ctx.pattern)
        ? ctx.pattern
        : ctx.pattern
          ? [ctx.pattern]
          : [];

      await handlePermissionAsk(
        ctx.sessionID,
        ctx.id,
        ctx.type,
        patterns,
        ctx.metadata,
        linear,
        log,
      );
    },
  };
}
