/**
 * Linear tools for the OpenCode plugin.
 *
 * Authenticated with the agent's OAuth token from store.json so actions
 * appear as the agent app rather than the current user.
 */

import { tool } from "@opencode-ai/plugin";
import { LinearClient } from "@linear/sdk";
import { Result } from "better-result";
import { readAnyAccessToken } from "./storage";

const z = tool.schema;

let cachedClient: { token: string; client: LinearClient } | null = null;

async function getClient(): Promise<Result<LinearClient, string>> {
  const token = await readAnyAccessToken();
  if (!token) {
    return Result.err(
      "No Linear access token found in store. Ensure the agent server has authenticated.",
    );
  }
  if (cachedClient && cachedClient.token === token) {
    return Result.ok(cachedClient.client);
  }
  const client = new LinearClient({ accessToken: token });
  cachedClient = { token, client };
  return Result.ok(client);
}

function errorJson(message: string): string {
  return JSON.stringify({ error: message });
}

export const linearTools = {
  linear_get_issue: tool({
    description:
      "Get details of a Linear issue by ID or identifier (e.g. 'CODE-42')",
    args: {
      id: z.string().describe("Issue ID or identifier"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
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
            assignee: assignee
              ? { id: assignee.id, name: assignee.name }
              : null,
            team: team ? { id: team.id, name: team.name, key: team.key } : null,
            priority: issue.priority,
            priorityLabel: issue.priorityLabel,
            labels: labels.nodes.map((l) => ({ id: l.id, name: l.name })),
            url: issue.url,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          });
        },
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to fetch issue",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
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
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const issue = await client.issue(args.id);
          const warnings: string[] = [];

          const update: Record<string, unknown> = {};
          if (args.title !== undefined) update.title = args.title;
          if (args.description !== undefined)
            update.description = args.description;
          if (args.priority !== undefined) update.priority = args.priority;

          if (args.state !== undefined) {
            const stateName = args.state;
            const team = await issue.team;
            if (team) {
              const states = await team.states();
              const match = states.nodes.find(
                (s) => s.name.toLowerCase() === stateName.toLowerCase(),
              );
              if (match) {
                update.stateId = match.id;
              } else {
                warnings.push(
                  `State "${stateName}" not found. Available: ${states.nodes.map((s) => s.name).join(", ")}`,
                );
              }
            } else {
              warnings.push("Could not resolve team for state lookup");
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
            if (match) {
              update.assigneeId = match.id;
            } else {
              warnings.push(`Assignee "${assigneeName}" not found`);
            }
          }

          if (args.labels !== undefined) {
            const team = await issue.team;
            if (team) {
              const allLabels = await team.labels();
              const ids: string[] = [];
              const unresolved: string[] = [];
              for (const name of args.labels) {
                const match = allLabels.nodes.find(
                  (l) =>
                    l.id === name ||
                    l.name.toLowerCase() === name.toLowerCase(),
                );
                if (match) {
                  ids.push(match.id);
                } else {
                  unresolved.push(name);
                }
              }
              if (ids.length > 0) update.labelIds = ids;
              if (unresolved.length > 0) {
                warnings.push(
                  `Labels not found: ${unresolved.join(", ")}. Available: ${allLabels.nodes.map((l) => l.name).join(", ")}`,
                );
              }
            } else {
              warnings.push("Could not resolve team for label lookup");
            }
          }

          await issue.update(update);
          return JSON.stringify({
            success: true,
            issueId: issue.id,
            ...(warnings.length > 0 ? { warnings } : {}),
          });
        },
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to update issue",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),

  linear_create_issue: tool({
    description: "Create a new Linear issue. Always created in Triage state.",
    args: {
      title: z.string().describe("Issue title"),
      teamKey: z.string().describe("Team key (e.g. 'CODE')"),
      description: z
        .string()
        .optional()
        .describe("Issue description (markdown)"),
      priority: z
        .number()
        .describe("Priority: 1=Urgent, 2=High, 3=Normal, 4=Low"),
      label: z
        .string()
        .describe("A repo:* label name (e.g. 'repo:linear-opencode-agent')"),
      assignee: z
        .string()
        .optional()
        .describe("Assignee user ID, name, or email"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const teams = await client.teams({
            filter: { key: { eq: args.teamKey } },
          });
          const team = teams.nodes[0];
          if (!team) {
            return JSON.stringify({
              error: `Team with key "${args.teamKey}" not found`,
            });
          }

          const states = await team.states();
          const triage = states.nodes.find(
            (s) => s.name.toLowerCase() === "triage",
          );

          const allLabels = await team.labels();
          const label = allLabels.nodes.find(
            (l) =>
              l.id === args.label ||
              l.name.toLowerCase() === args.label.toLowerCase(),
          );

          let assigneeId: string | undefined;
          if (args.assignee) {
            const org = await client.organization;
            const users = await org.users();
            const match = users.nodes.find(
              (u) =>
                u.id === args.assignee ||
                u.name.toLowerCase() === args.assignee?.toLowerCase() ||
                u.email.toLowerCase() === args.assignee?.toLowerCase(),
            );
            if (match) assigneeId = match.id;
          }

          const payload = await client.createIssue({
            title: args.title,
            teamId: team.id,
            priority: args.priority,
            description: args.description,
            stateId: triage?.id,
            labelIds: label ? [label.id] : undefined,
            assigneeId,
          });
          const issue = await payload.issue;
          return JSON.stringify({
            success: true,
            id: issue?.id,
            identifier: issue?.identifier,
            url: issue?.url,
          });
        },
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to create issue",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),

  linear_create_comment: tool({
    description: "Create a comment on a Linear issue",
    args: {
      issueId: z.string().describe("Issue ID or identifier"),
      body: z.string().describe("Comment body (markdown)"),
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
          });
          const comment = await payload.comment;
          return JSON.stringify({
            success: true,
            commentId: comment?.id,
          });
        },
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to create comment",
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
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to list comments",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
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
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const limit = args.limit ?? 20;

          const filter: Record<string, unknown> = {};

          if (args.state) {
            filter.state = { name: { containsIgnoreCase: args.state } };
          }
          if (args.assignee) {
            filter.assignee = {
              or: [
                { name: { containsIgnoreCase: args.assignee } },
                { email: { containsIgnoreCase: args.assignee } },
              ],
            };
          }
          if (args.team) {
            filter.team = { key: { eq: args.team } };
          }
          if (args.query) {
            filter.searchableContent = { contains: args.query };
          }

          const issues = await client.issues({
            first: limit,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
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
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to list issues",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),

  linear_list_projects: tool({
    description:
      "List Linear projects in the workspace. Returns summary info only — use linear_get_project for full details.",
    args: {
      team: z.string().optional().describe("Filter by team key (e.g. 'CODE')"),
      state: z
        .string()
        .optional()
        .describe(
          "Filter by project state: planned, started, paused, completed, canceled",
        ),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const limit = args.limit ?? 20;
          const filter: Record<string, unknown> = {};

          if (args.team) {
            filter.accessibleTeams = { key: { eq: args.team } };
          }
          if (args.state) {
            filter.state = { eq: args.state };
          }

          const projects = await client.projects({
            first: limit,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
          });

          const results = projects.nodes.map((project) => ({
            id: project.id,
            name: project.name,
            state: project.state,
            progress: project.progress,
            url: project.url,
          }));

          return JSON.stringify(results);
        },
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to list projects",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),

  linear_get_project: tool({
    description: "Get full details of a Linear project by ID",
    args: {
      id: z.string().describe("The project ID"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const project = await client.project(args.id);
          const lead = await project.lead;
          const teams = await project.teams();
          const members = await project.members();

          return JSON.stringify({
            id: project.id,
            name: project.name,
            state: project.state,
            description: project.description,
            lead: lead?.name,
            teams: teams.nodes.map((t) => ({ key: t.key, name: t.name })),
            members: members.nodes.map((m) => m.name),
            progress: project.progress,
            startDate: project.startDate,
            targetDate: project.targetDate,
            url: project.url,
          });
        },
        catch: (e) =>
          e instanceof Error ? e.message : "Failed to get project",
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),
};
