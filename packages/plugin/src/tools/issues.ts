/**
 * Linear issue tools: get, create, update, list.
 */

import { tool } from "@opencode-ai/plugin";
import { PaginationOrderBy } from "@linear/sdk";
import { Result } from "better-result";
import {
  getClient,
  errorJson,
  withWarnings,
  errMsg,
  parseDateFilter,
} from "./utils";
import {
  resolveTeam,
  resolveUser,
  resolveState,
  resolveLabels,
  resolveProject,
  resolveCycle,
} from "./resolve";
import { syncRelations } from "./relations";

const z = tool.schema;

export const issueTools = {
  linear_get_issue: tool({
    description:
      "Get details of a Linear issue by ID or identifier (e.g. 'CODE-42')",
    args: {
      id: z.string().describe("Issue ID or identifier"),
      includeRelations: z
        .boolean()
        .optional()
        .describe("Include blocking/blocked by/related/duplicate relations"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const issue = await client.issue(args.id);
          const [
            state,
            assignee,
            delegate,
            team,
            labels,
            parent,
            project,
            cycle,
            attachments,
          ] = await Promise.all([
            issue.state,
            issue.assignee,
            issue.delegate,
            issue.team,
            issue.labels(),
            issue.parent,
            issue.project,
            issue.cycle,
            issue.attachments(),
          ]);

          const data: Record<string, unknown> = {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            state: state ? { name: state.name, type: state.type } : null,
            assignee: assignee
              ? { id: assignee.id, name: assignee.name }
              : null,
            delegate: delegate
              ? { id: delegate.id, name: delegate.name }
              : null,
            team: team ? { id: team.id, name: team.name, key: team.key } : null,
            priority: issue.priority,
            priorityLabel: issue.priorityLabel,
            labels: labels.nodes.map((l) => ({ id: l.id, name: l.name })),
            estimate: issue.estimate,
            dueDate: issue.dueDate,
            parent: parent
              ? {
                  id: parent.id,
                  identifier: parent.identifier,
                  title: parent.title,
                }
              : null,
            project: project ? { id: project.id, name: project.name } : null,
            cycle: cycle
              ? { id: cycle.id, number: cycle.number, name: cycle.name }
              : null,
            attachments: attachments.nodes.map((a) => ({
              id: a.id,
              title: a.title,
              url: a.url,
            })),
            url: issue.url,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          };

          if (args.includeRelations) {
            const [relations, inverseRelations] = await Promise.all([
              issue.relations(),
              issue.inverseRelations(),
            ]);

            const blocks: { id: string; identifier: string; title: string }[] =
              [];
            const blockedBy: {
              id: string;
              identifier: string;
              title: string;
            }[] = [];
            const related: {
              id: string;
              identifier: string;
              title: string;
            }[] = [];
            const duplicate: {
              id: string;
              identifier: string;
              title: string;
            }[] = [];

            for (const rel of relations.nodes) {
              const target = await rel.relatedIssue;
              if (!target) continue;
              const entry = {
                id: target.id,
                identifier: target.identifier,
                title: target.title,
              };
              switch (rel.type) {
                case "blocks":
                  blocks.push(entry);
                  break;
                case "duplicate":
                  duplicate.push(entry);
                  break;
                case "related":
                  related.push(entry);
                  break;
              }
            }

            for (const rel of inverseRelations.nodes) {
              const source = await rel.issue;
              if (!source) continue;
              const entry = {
                id: source.id,
                identifier: source.identifier,
                title: source.title,
              };
              switch (rel.type) {
                case "blocks":
                  blockedBy.push(entry);
                  break;
                case "duplicate":
                  duplicate.push(entry);
                  break;
                case "related":
                  related.push(entry);
                  break;
              }
            }

            data.relations = { blocks, blockedBy, related, duplicate };
          }

          return JSON.stringify(data);
        },
        catch: (e) => errMsg(e),
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
        .describe("State name, type, or ID (e.g. 'In Progress', 'completed')"),
      assignee: z
        .string()
        .optional()
        .nullable()
        .describe("Assignee user ID, name, email, or 'me'. Null to unassign"),
      priority: z
        .number()
        .optional()
        .describe("Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Label names or IDs to set"),
      project: z
        .string()
        .optional()
        .nullable()
        .describe("Project name or ID. Null to remove"),
      cycle: z
        .string()
        .optional()
        .nullable()
        .describe("Cycle name, number, or ID. Null to remove"),
      estimate: z.number().optional().describe("Issue estimate value"),
      dueDate: z
        .string()
        .optional()
        .nullable()
        .describe("Due date (ISO format). Null to remove"),
      parentId: z
        .string()
        .optional()
        .nullable()
        .describe("Parent issue ID. Null to remove"),
      team: z.string().optional().describe("Move to team (name, key, or ID)"),
      delegate: z
        .string()
        .optional()
        .nullable()
        .describe("Delegate agent name, user ID, or 'me'. Null to remove"),
      milestone: z
        .string()
        .optional()
        .nullable()
        .describe("Project milestone ID. Null to remove"),
      links: z
        .array(z.object({ url: z.string(), title: z.string() }))
        .optional()
        .describe("Link attachments to add [{url, title}]"),
      blocks: z
        .array(z.string())
        .optional()
        .describe("Issue IDs/identifiers this issue blocks. Replaces existing"),
      blockedBy: z
        .array(z.string())
        .optional()
        .describe("Issue IDs/identifiers blocking this. Replaces existing"),
      relatedTo: z
        .array(z.string())
        .optional()
        .describe("Related issue IDs/identifiers. Replaces existing"),
      duplicateOf: z
        .string()
        .optional()
        .nullable()
        .describe("Duplicate of issue ID/identifier. Null to remove"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const issue = await client.issue(args.id);
          const warnings: string[] = [];

          const team = await issue.team;
          const teamId = team?.id;

          let stateId: string | undefined;
          if (args.state !== undefined && teamId) {
            stateId = await resolveState(client, teamId, args.state, warnings);
          }

          let assigneeId: string | null | undefined;
          if (args.assignee === null) {
            assigneeId = null;
          } else if (args.assignee !== undefined) {
            assigneeId = await resolveUser(client, args.assignee, warnings);
          }

          let labelIds: string[] | undefined;
          if (args.labels !== undefined && teamId) {
            labelIds = await resolveLabels(
              client,
              teamId,
              args.labels,
              warnings,
            );
          }

          let projectId: string | null | undefined;
          if (args.project === null) {
            projectId = null;
          } else if (args.project !== undefined) {
            projectId = await resolveProject(client, args.project, warnings);
          }

          let cycleId: string | null | undefined;
          if (args.cycle === null) {
            cycleId = null;
          } else if (args.cycle !== undefined && teamId) {
            cycleId = await resolveCycle(client, teamId, args.cycle, warnings);
          }

          let moveTeamId: string | undefined;
          if (args.team !== undefined) {
            moveTeamId = await resolveTeam(client, args.team, warnings);
          }

          let delegateId: string | null | undefined;
          if (args.delegate === null) {
            delegateId = null;
          } else if (args.delegate !== undefined) {
            delegateId = await resolveUser(client, args.delegate, warnings);
          }

          await issue.update({
            title: args.title,
            description: args.description,
            priority: args.priority,
            estimate: args.estimate,
            dueDate: args.dueDate,
            parentId: args.parentId,
            projectMilestoneId: args.milestone,
            stateId,
            assigneeId,
            labelIds,
            projectId,
            cycleId,
            teamId: moveTeamId,
            delegateId,
          });

          if (args.links) {
            for (const link of args.links) {
              await client.attachmentLinkURL(issue.id, link.url, {
                title: link.title,
              });
            }
          }

          await syncRelations(client, issue.id, args, warnings);

          return withWarnings({ success: true, issueId: issue.id }, warnings);
        },
        catch: (e) => errMsg(e),
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),

  linear_create_issue: tool({
    description: "Create a new Linear issue",
    args: {
      title: z.string().describe("Issue title"),
      team: z.string().describe("Team name, key, or ID"),
      description: z
        .string()
        .optional()
        .describe("Issue description (markdown)"),
      priority: z
        .number()
        .optional()
        .describe("Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
      state: z
        .string()
        .optional()
        .describe("State name or type. Defaults to Triage if not specified"),
      labels: z.array(z.string()).optional().describe("Label names or IDs"),
      assignee: z
        .string()
        .optional()
        .describe("Assignee user ID, name, email, or 'me'"),
      delegate: z
        .string()
        .optional()
        .describe("Delegate agent name, user ID, or 'me'"),
      project: z.string().optional().describe("Project name or ID"),
      cycle: z.string().optional().describe("Cycle name, number, or ID"),
      estimate: z.number().optional().describe("Issue estimate value"),
      dueDate: z.string().optional().describe("Due date (ISO format)"),
      parentId: z.string().optional().describe("Parent issue ID or identifier"),
      blocks: z
        .array(z.string())
        .optional()
        .describe("Issue IDs/identifiers this issue blocks"),
      blockedBy: z
        .array(z.string())
        .optional()
        .describe("Issue IDs/identifiers blocking this"),
      relatedTo: z
        .array(z.string())
        .optional()
        .describe("Related issue IDs/identifiers"),
      duplicateOf: z
        .string()
        .optional()
        .nullable()
        .describe("Duplicate of issue ID/identifier"),
      links: z
        .array(z.object({ url: z.string(), title: z.string() }))
        .optional()
        .describe("Link attachments [{url, title}]"),
    },
    async execute(args): Promise<string> {
      const clientResult = await getClient();
      if (Result.isError(clientResult)) return errorJson(clientResult.error);
      const client = clientResult.value;

      const result = await Result.tryPromise({
        try: async () => {
          const warnings: string[] = [];
          const teamId = await resolveTeam(client, args.team, warnings);
          if (!teamId) {
            return JSON.stringify({ error: warnings[0] });
          }

          let stateId: string | undefined;
          if (args.state) {
            stateId = await resolveState(client, teamId, args.state, warnings);
          } else {
            stateId = await resolveState(client, teamId, "triage", warnings);
          }

          let assigneeId: string | undefined;
          if (args.assignee) {
            assigneeId = await resolveUser(client, args.assignee, warnings);
          }

          let delegateId: string | undefined;
          if (args.delegate) {
            delegateId = await resolveUser(client, args.delegate, warnings);
          }

          let labelIds: string[] | undefined;
          if (args.labels) {
            const ids = await resolveLabels(
              client,
              teamId,
              args.labels,
              warnings,
            );
            if (ids.length > 0) labelIds = ids;
          }

          let projectId: string | undefined;
          if (args.project) {
            projectId = await resolveProject(client, args.project, warnings);
          }

          let cycleId: string | undefined;
          if (args.cycle) {
            cycleId = await resolveCycle(client, teamId, args.cycle, warnings);
          }

          const payload = await client.createIssue({
            title: args.title,
            teamId,
            description: args.description,
            priority: args.priority,
            estimate: args.estimate,
            dueDate: args.dueDate,
            parentId: args.parentId,
            stateId,
            assigneeId,
            delegateId,
            labelIds,
            projectId,
            cycleId,
          });
          const issue = await payload.issue;
          if (!issue) {
            return JSON.stringify({
              error: "Issue creation returned no issue",
            });
          }

          if (args.links) {
            for (const link of args.links) {
              await client.attachmentLinkURL(issue.id, link.url, {
                title: link.title,
              });
            }
          }

          await syncRelations(client, issue.id, args, warnings);

          return withWarnings(
            {
              success: true,
              id: issue.id,
              identifier: issue.identifier,
              url: issue.url,
            },
            warnings,
          );
        },
        catch: (e) => errMsg(e),
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
        .describe("Filter by assignee name, email, or 'me'"),
      team: z.string().optional().describe("Filter by team name or key"),
      delegate: z
        .string()
        .optional()
        .describe("Filter by delegate/agent name, email, or 'me'"),
      label: z
        .string()
        .optional()
        .describe("Filter by label name (exact match)"),
      project: z.string().optional().describe("Filter by project name or ID"),
      cycle: z
        .string()
        .optional()
        .describe("Filter by cycle name, number, or ID"),
      parentId: z.string().optional().describe("Filter by parent issue ID"),
      createdAt: z
        .string()
        .optional()
        .describe("Created after: ISO-8601 date/duration (e.g. -P1D)"),
      updatedAt: z
        .string()
        .optional()
        .describe("Updated after: ISO-8601 date/duration (e.g. -P1D)"),
      orderBy: z
        .enum(["createdAt", "updatedAt"])
        .optional()
        .describe("Sort order (default updatedAt)"),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Include archived issues"),
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

          if (args.state) {
            filter.state = { name: { containsIgnoreCase: args.state } };
          } else {
            filter.state = { type: { nin: ["completed", "canceled"] } };
          }
          if (args.assignee) {
            if (args.assignee === "me") {
              const me = await client.viewer;
              filter.assignee = { id: { eq: me.id } };
            } else {
              filter.assignee = {
                or: [
                  { name: { containsIgnoreCase: args.assignee } },
                  { email: { containsIgnoreCase: args.assignee } },
                ],
              };
            }
          }
          if (args.delegate) {
            if (args.delegate === "me") {
              const me = await client.viewer;
              filter.delegate = { id: { eq: me.id } };
            } else {
              filter.delegate = {
                or: [
                  { name: { containsIgnoreCase: args.delegate } },
                  { email: { containsIgnoreCase: args.delegate } },
                ],
              };
            }
          }
          if (args.team) {
            filter.team = {
              or: [
                { key: { eq: args.team } },
                { name: { containsIgnoreCase: args.team } },
              ],
            };
          }
          if (args.label) {
            filter.labels = { some: { name: { eq: args.label } } };
          }
          if (args.query) {
            filter.searchableContent = { contains: args.query };
          }
          if (args.project) {
            filter.project = {
              or: [
                { id: { eq: args.project } },
                { name: { containsIgnoreCase: args.project } },
              ],
            };
          }
          if (args.cycle) {
            const num = parseInt(args.cycle, 10);
            filter.cycle = {
              or: [
                { id: { eq: args.cycle } },
                { name: { containsIgnoreCase: args.cycle } },
                ...(Number.isNaN(num) ? [] : [{ number: { eq: num } }]),
              ],
            };
          }
          if (args.parentId) {
            filter.parent = { id: { eq: args.parentId } };
          }
          if (args.createdAt) {
            filter.createdAt = { gte: parseDateFilter(args.createdAt) };
          }
          if (args.updatedAt) {
            filter.updatedAt = { gte: parseDateFilter(args.updatedAt) };
          }

          const issues = await client.issues({
            first: limit,
            after: args.cursor,
            includeArchived: args.includeArchived,
            orderBy:
              args.orderBy === "createdAt"
                ? PaginationOrderBy.CreatedAt
                : undefined,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
          });

          const results = await Promise.all(
            issues.nodes.map(async (issue) => {
              const [state, assignee, delegate, labels, attachments] =
                await Promise.all([
                  issue.state,
                  issue.assignee,
                  issue.delegate,
                  issue.labels(),
                  issue.attachments(),
                ]);
              return {
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                state: state?.name,
                assignee: assignee?.name,
                delegate: delegate?.name ?? null,
                priority: issue.priorityLabel,
                labels: labels.nodes.map((l) => l.name),
                attachments: attachments.nodes.map((a) => ({
                  title: a.title,
                  url: a.url,
                })),
                url: issue.url,
              };
            }),
          );

          const response: Record<string, unknown> = { issues: results };
          if (issues.pageInfo.hasNextPage && issues.pageInfo.endCursor) {
            response.nextCursor = issues.pageInfo.endCursor;
          }
          return JSON.stringify(response);
        },
        catch: (e) => errMsg(e),
      });
      return Result.isError(result) ? errorJson(result.error) : result.value;
    },
  }),
};
