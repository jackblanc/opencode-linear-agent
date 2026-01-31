/**
 * Linear comment tools: create, list.
 */

import { tool } from "@opencode-ai/plugin";
import { Result } from "better-result";
import { getClient, errorJson, errMsg } from "./utils";

const z = tool.schema;

export const commentTools = {
  linear_create_comment: tool({
    description: "Create a comment on a Linear issue",
    args: {
      issueId: z.string().describe("Issue ID or identifier"),
      body: z.string().describe("Comment body (markdown)"),
      parentId: z
        .string()
        .optional()
        .describe("Parent comment ID for threaded replies"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const issue = await client.issue(args.issueId);
          const payload = await client.createComment({
            issueId: issue.id,
            body: args.body,
            parentId: args.parentId,
          });
          const comment = await payload.comment;
          return JSON.stringify({ success: true, commentId: comment?.id });
        },
        catch: (e) => errMsg(e),
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),

  linear_list_comments: tool({
    description: "List comments on a Linear issue",
    args: {
      issueId: z.string().describe("Issue ID or identifier"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const issue = await client.issue(args.issueId);
          const comments = await issue.comments();
          const results = await Promise.all(
            comments.nodes.map(async (c) => {
              const user = await c.user;
              return {
                id: c.id,
                body: c.body,
                user: user ? { id: user.id, name: user.name } : null,
                createdAt: c.createdAt,
              };
            }),
          );
          return JSON.stringify(results);
        },
        catch: (e) => errMsg(e),
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),
};
