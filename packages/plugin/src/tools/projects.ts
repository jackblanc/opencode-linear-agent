/**
 * Linear project tools: get, create, update, list.
 */

import { tool } from "@opencode-ai/plugin";
import { PaginationOrderBy } from "@linear/sdk";
import { Result } from "better-result";
import type { GetLinearClient } from "./utils";
import { errorJson, withWarnings, errMsg, parseDateFilter } from "./utils";
import {
  resolveTeam,
  resolveUser,
  resolveProjectStatus,
  resolveProjectLabels,
} from "./resolve";

const z = tool.schema;

export function createProjectTools(getClient: GetLinearClient) {
  return {
    linear_list_projects: tool({
      description:
        "List Linear projects in the workspace. Returns summary fields only, including the short API `description` field but not full markdown `content` — use linear_get_project for full details.",
      args: {
        team: z.string().optional().describe("Filter by team name or key"),
        state: z
          .string()
          .optional()
          .describe(
            "Filter by project state: planned, started, paused, completed, canceled",
          ),
        query: z.string().optional().describe("Search by project name"),
        member: z
          .string()
          .optional()
          .describe("Filter by member name, email, or 'me'"),
        initiative: z
          .string()
          .optional()
          .describe("Filter by initiative name or ID"),
        createdAt: z
          .string()
          .optional()
          .describe("Created after: ISO-8601 date/duration"),
        updatedAt: z
          .string()
          .optional()
          .describe("Updated after: ISO-8601 date/duration"),
        orderBy: z
          .enum(["createdAt", "updatedAt"])
          .optional()
          .describe("Sort order (default updatedAt)"),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include archived projects"),
        limit: z
          .number()
          .optional()
          .describe("Max results (default 20, max 250)"),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from previous result"),
      },
      async execute(args): Promise<string> {
        const clientResult = await getClient();
        if (Result.isError(clientResult)) return errorJson(clientResult.error);
        const client = clientResult.value;

        const result = await Result.tryPromise({
          try: async () => {
            const limit = Math.min(args.limit ?? 20, 250);
            const filter: Record<string, unknown> = {};

            if (args.team) {
              filter.accessibleTeams = {
                some: {
                  or: [
                    { key: { eq: args.team } },
                    { name: { containsIgnoreCase: args.team } },
                  ],
                },
              };
            }
            if (args.state) {
              filter.state = { eq: args.state };
            }
            if (args.query) {
              filter.name = { containsIgnoreCase: args.query };
            }
            if (args.member) {
              if (args.member === "me") {
                const me = await client.viewer;
                filter.members = { id: { eq: me.id } };
              } else {
                filter.members = {
                  or: [
                    { name: { containsIgnoreCase: args.member } },
                    { email: { containsIgnoreCase: args.member } },
                  ],
                };
              }
            }
            if (args.initiative) {
              filter.initiatives = {
                or: [
                  { id: { eq: args.initiative } },
                  { name: { containsIgnoreCase: args.initiative } },
                ],
              };
            }
            if (args.createdAt) {
              filter.createdAt = { gte: parseDateFilter(args.createdAt) };
            }
            if (args.updatedAt) {
              filter.updatedAt = { gte: parseDateFilter(args.updatedAt) };
            }

            const projects = await client.projects({
              first: limit,
              after: args.cursor,
              includeArchived: args.includeArchived,
              orderBy:
                args.orderBy === "createdAt"
                  ? PaginationOrderBy.CreatedAt
                  : undefined,
              filter: Object.keys(filter).length > 0 ? filter : undefined,
            });

            const results = projects.nodes.map((p) => ({
              id: p.id,
              name: p.name,
              state: p.state,
              progress: p.progress,
              url: p.url,
            }));

            const response: Record<string, unknown> = { projects: results };
            if (projects.pageInfo.hasNextPage && projects.pageInfo.endCursor) {
              response.nextCursor = projects.pageInfo.endCursor;
            }
            return JSON.stringify(response);
          },
          catch: (e) => errMsg(e),
        });
        return Result.isError(result) ? errorJson(result.error) : result.value;
      },
    }),

    linear_get_project: tool({
      description:
        "Get full details of a Linear project by ID or name, including both the short API `description` field and full markdown `content`",
      args: {
        id: z.string().describe("Project ID or name"),
        includeMilestones: z
          .boolean()
          .optional()
          .describe("Include project milestones"),
      },
      async execute(args): Promise<string> {
        const clientResult = await getClient();
        if (Result.isError(clientResult)) return errorJson(clientResult.error);
        const client = clientResult.value;

        const result = await Result.tryPromise({
          try: async () => {
            const tryDirect = await Result.tryPromise({
              try: async () => client.project(args.id),
              catch: () => "not found",
            });
            let project = Result.isOk(tryDirect) ? tryDirect.value : undefined;
            if (!project) {
              const projects = await client.projects({
                filter: { name: { containsIgnoreCase: args.id } },
              });
              project = projects.nodes[0];
            }
            if (!project) {
              return errorJson(`Project "${args.id}" not found`);
            }

            const [lead, teams, members] = await Promise.all([
              project.lead,
              project.teams(),
              project.members(),
            ]);

            const data: Record<string, unknown> = {
              id: project.id,
              name: project.name,
              state: project.state,
              description: project.description,
              content: project.content,
              lead: lead ? { id: lead.id, name: lead.name } : null,
              teams: teams.nodes.map((t) => ({ key: t.key, name: t.name })),
              members: members.nodes.map((m) => ({ id: m.id, name: m.name })),
              progress: project.progress,
              priority: project.priority,
              startDate: project.startDate,
              targetDate: project.targetDate,
              url: project.url,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            };

            if (args.includeMilestones) {
              const milestones = await project.projectMilestones();
              data.milestones = milestones.nodes.map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description,
                targetDate: m.targetDate,
                sortOrder: m.sortOrder,
                status: m.status,
              }));
            }

            return JSON.stringify(data);
          },
          catch: (e) => errMsg(e),
        });
        return Result.isError(result) ? errorJson(result.error) : result.value;
      },
    }),

    linear_create_project: tool({
      description:
        "Create a new Linear project. Set short summary in `description` and full markdown body in `content`",
      args: {
        name: z.string().describe("Project name"),
        team: z.string().describe("Team name, key, or ID"),
        description: z.string().optional().describe("Project description"),
        content: z.string().optional().describe("Project content (markdown)"),
        lead: z
          .string()
          .optional()
          .describe("Lead user ID, name, email, or 'me'"),
        priority: z
          .number()
          .optional()
          .describe("Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
        startDate: z.string().optional().describe("Start date (ISO format)"),
        targetDate: z.string().optional().describe("Target date (ISO format)"),
        labels: z.array(z.string()).optional().describe("Label names or IDs"),
        state: z
          .string()
          .optional()
          .describe(
            "Project status name or type (e.g. Planned, Started, Paused, Completed, Canceled)",
          ),
        color: z.string().optional().describe("Hex color"),
        icon: z.string().optional().describe("Icon emoji"),
      },
      async execute(args): Promise<string> {
        const clientResult = await getClient();
        if (Result.isError(clientResult)) return errorJson(clientResult.error);
        const client = clientResult.value;

        const result = await Result.tryPromise({
          try: async () => {
            const warnings: string[] = [];
            const teamId = await resolveTeam(client, args.team, warnings);
            if (!teamId) return JSON.stringify({ error: warnings[0] });

            let leadId: string | undefined;
            if (args.lead) {
              leadId = await resolveUser(client, args.lead, warnings);
            }

            let labelIds: string[] | undefined;
            if (args.labels) {
              const ids = await resolveProjectLabels(
                client,
                args.labels,
                warnings,
              );
              if (ids.length > 0) labelIds = ids;
            }

            let statusId: string | undefined;
            if (args.state) {
              statusId = await resolveProjectStatus(
                client,
                args.state,
                warnings,
              );
            }

            const payload = await client.createProject({
              name: args.name,
              teamIds: [teamId],
              description: args.description,
              content: args.content,
              priority: args.priority,
              startDate: args.startDate,
              targetDate: args.targetDate,
              color: args.color,
              icon: args.icon,
              leadId,
              labelIds,
              statusId,
            });
            const project = await payload.project;
            return withWarnings(
              {
                success: true,
                id: project?.id,
                name: project?.name,
                url: project?.url,
              },
              warnings,
            );
          },
          catch: (e) => errMsg(e),
        });
        return Result.isError(result) ? errorJson(result.error) : result.value;
      },
    }),

    linear_update_project: tool({
      description:
        "Update an existing Linear project. `description` is the short summary; `content` is the full markdown body",
      args: {
        id: z.string().describe("Project ID"),
        name: z.string().optional().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        content: z.string().optional().describe("Project content (markdown)"),
        lead: z
          .string()
          .optional()
          .nullable()
          .describe("Lead user ID, name, email, or 'me'. Null to remove"),
        priority: z
          .number()
          .optional()
          .describe("Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
        startDate: z.string().optional().describe("Start date (ISO format)"),
        targetDate: z.string().optional().describe("Target date (ISO format)"),
        state: z
          .string()
          .optional()
          .describe(
            "Project status name or type (e.g. Planned, Started, Paused, Completed, Canceled)",
          ),
        labels: z
          .array(z.string())
          .optional()
          .describe("Project label names or IDs to set"),
        color: z.string().optional().describe("Hex color"),
        icon: z.string().optional().describe("Icon emoji"),
      },
      async execute(args): Promise<string> {
        const clientResult = await getClient();
        if (Result.isError(clientResult)) return errorJson(clientResult.error);
        const client = clientResult.value;

        const result = await Result.tryPromise({
          try: async () => {
            const warnings: string[] = [];

            let leadId: string | null | undefined;
            if (args.lead === null) {
              leadId = null;
            } else if (args.lead !== undefined) {
              leadId = await resolveUser(client, args.lead, warnings);
            }

            let statusId: string | undefined;
            if (args.state) {
              statusId = await resolveProjectStatus(
                client,
                args.state,
                warnings,
              );
            }

            let labelIds: string[] | undefined;
            if (args.labels) {
              const ids = await resolveProjectLabels(
                client,
                args.labels,
                warnings,
              );
              if (ids.length > 0) labelIds = ids;
            }

            await client.updateProject(args.id, {
              name: args.name,
              description: args.description,
              content: args.content,
              priority: args.priority,
              startDate: args.startDate,
              targetDate: args.targetDate,
              color: args.color,
              icon: args.icon,
              leadId,
              statusId,
              labelIds,
            });
            return withWarnings(
              { success: true, projectId: args.id },
              warnings,
            );
          },
          catch: (e) => errMsg(e),
        });
        return Result.isError(result) ? errorJson(result.error) : result.value;
      },
    }),
  };
}
