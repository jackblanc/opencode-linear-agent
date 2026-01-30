/**
 * Linear tools for the OpenCode plugin.
 *
 * Authenticated with the agent's OAuth token from store.json so actions
 * appear as the agent app rather than the current user.
 */

import { tool } from "@opencode-ai/plugin";
import { LinearClient } from "@linear/sdk";
import { readAnyAccessToken } from "./storage";

const z = tool.schema;

async function getClient(): Promise<LinearClient> {
  const token = await readAnyAccessToken();
  if (!token) {
    throw new Error(
      "No Linear access token found in store. Ensure the agent server has authenticated.",
    );
  }
  return new LinearClient({ accessToken: token });
}

export const linearTools = {
  linear_get_issue: tool({
    description:
      "Get details of a Linear issue by ID or identifier (e.g. 'CODE-42')",
    args: {
      id: z.string().describe("Issue ID or identifier"),
    },
    async execute(args): Promise<string> {
      const client = await getClient();
      const issue = await client.issue(args.id);
      const state = await issue.state;
      const assignee = await issue.assignee;
      const team = await issue.team;
      const labels = await issue.labels();
      return JSON.stringify({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        state: state ? { name: state.name, type: state.type } : null,
        assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
        team: team ? { id: team.id, name: team.name, key: team.key } : null,
        priority: issue.priority,
        priorityLabel: issue.priorityLabel,
        labels: labels.nodes.map((l) => ({ id: l.id, name: l.name })),
        url: issue.url,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      });
    },
  }),

  linear_update_issue: tool({
    description: "Update a Linear issue's properties",
    args: {
      id: z.string().describe("Issue ID or identifier"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description (markdown)"),
      state: z
        .string()
        .optional()
        .describe("State name (e.g. 'In Progress', 'Done')"),
      assignee: z
        .string()
        .optional()
        .describe("Assignee user ID, name, or email"),
      priority: z
        .number()
        .optional()
        .describe("Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Label names or IDs to set"),
    },
    async execute(args): Promise<string> {
      const client = await getClient();
      const issue = await client.issue(args.id);

      const update: Record<string, unknown> = {};
      if (args.title !== undefined) update.title = args.title;
      if (args.description !== undefined) update.description = args.description;
      if (args.priority !== undefined) update.priority = args.priority;

      if (args.state !== undefined) {
        const stateName = args.state;
        const team = await issue.team;
        if (team) {
          const states = await team.states();
          const match = states.nodes.find(
            (s) => s.name.toLowerCase() === stateName.toLowerCase(),
          );
          if (match) update.stateId = match.id;
        }
      }

      if (args.assignee !== undefined) {
        const assigneeName = args.assignee;
        const org = await client.organization;
        const users = await org.users();
        const match = users.nodes.find(
          (u) =>
            u.id === assigneeName ||
            u.name.toLowerCase() === assigneeName.toLowerCase() ||
            u.email.toLowerCase() === assigneeName.toLowerCase(),
        );
        if (match) update.assigneeId = match.id;
      }

      if (args.labels !== undefined) {
        const team = await issue.team;
        if (team) {
          const allLabels = await team.labels();
          const ids = args.labels
            .map((name) => {
              const match = allLabels.nodes.find(
                (l) =>
                  l.id === name || l.name.toLowerCase() === name.toLowerCase(),
              );
              return match?.id;
            })
            .filter((id): id is string => id !== undefined);
          if (ids.length > 0) update.labelIds = ids;
        }
      }

      await issue.update(update);
      return JSON.stringify({ success: true, issueId: issue.id });
    },
  }),

  linear_create_comment: tool({
    description: "Create a comment on a Linear issue",
    args: {
      issueId: z.string().describe("Issue ID or identifier"),
      body: z.string().describe("Comment body (markdown)"),
    },
    async execute(args): Promise<string> {
      const client = await getClient();
      const issue = await client.issue(args.issueId);
      const payload = await client.createComment({
        issueId: issue.id,
        body: args.body,
      });
      const comment = await payload.comment;
      return JSON.stringify({
        success: true,
        commentId: comment?.id,
      });
    },
  }),

  linear_list_comments: tool({
    description: "List comments on a Linear issue",
    args: {
      issueId: z.string().describe("Issue ID or identifier"),
    },
    async execute(args): Promise<string> {
      const client = await getClient();
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
  }),

  linear_list_issues: tool({
    description: "Search and list Linear issues with optional filters",
    args: {
      query: z
        .string()
        .optional()
        .describe("Search query for title/description"),
      state: z.string().optional().describe("Filter by state name"),
      assignee: z
        .string()
        .optional()
        .describe("Filter by assignee name or email"),
      team: z.string().optional().describe("Filter by team key (e.g. 'CODE')"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async execute(args): Promise<string> {
      const client = await getClient();
      const limit = args.limit ?? 20;

      const filter: Record<string, unknown> = {};

      if (args.state) {
        filter.state = { name: { eqCaseInsensitive: args.state } };
      }
      if (args.assignee) {
        filter.assignee = {
          or: [
            { name: { eqCaseInsensitive: args.assignee } },
            { email: { eqCaseInsensitive: args.assignee } },
          ],
        };
      }
      if (args.team) {
        filter.team = { key: { eqCaseInsensitive: args.team } };
      }

      const issues = await client.issues({
        first: limit,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        ...(args.query
          ? {
              filter: {
                ...filter,
                searchableContent: { contains: args.query },
              },
            }
          : {}),
      });

      const results = await Promise.all(
        issues.nodes.map(async (issue) => {
          const state = await issue.state;
          const assignee = await issue.assignee;
          return {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            state: state?.name,
            assignee: assignee?.name,
            priority: issue.priorityLabel,
            url: issue.url,
          };
        }),
      );

      return JSON.stringify(results);
    },
  }),
};
