/**
 * Issue relation sync — replaces existing relations with the requested set.
 */

import { IssueRelationType } from "@linear/sdk";
import type { LinearClient } from "@linear/sdk";
import { Result } from "better-result";
import { errMsg } from "./utils";

export async function syncRelations(
  client: LinearClient,
  issueId: string,
  args: {
    blocks?: string[];
    blockedBy?: string[];
    relatedTo?: string[];
    duplicateOf?: string | null;
  },
  warnings: string[],
): Promise<void> {
  const hasRelationArgs =
    args.blocks !== undefined ||
    args.blockedBy !== undefined ||
    args.relatedTo !== undefined ||
    args.duplicateOf !== undefined;
  if (!hasRelationArgs) return;

  const issue = await client.issue(issueId);
  const [existing, existingInverse] = await Promise.all([
    issue.relations(),
    issue.inverseRelations(),
  ]);

  for (const rel of existing.nodes) {
    const shouldDelete =
      (rel.type === "blocks" && args.blocks !== undefined) ||
      (rel.type === "related" && args.relatedTo !== undefined) ||
      (rel.type === "duplicate" && args.duplicateOf !== undefined);
    if (shouldDelete) {
      await client.deleteIssueRelation(rel.id);
    }
  }
  for (const rel of existingInverse.nodes) {
    const shouldDelete =
      (rel.type === "blocks" && args.blockedBy !== undefined) ||
      (rel.type === "related" && args.relatedTo !== undefined) ||
      (rel.type === "duplicate" && args.duplicateOf !== undefined);
    if (shouldDelete) {
      await client.deleteIssueRelation(rel.id);
    }
  }

  if (args.blocks) {
    for (const target of args.blocks) {
      const r = await Result.tryPromise({
        try: async () =>
          client.createIssueRelation({
            issueId,
            relatedIssueId: target,
            type: IssueRelationType.Blocks,
          }),
        catch: (e) => errMsg(e),
      });
      if (Result.isError(r))
        warnings.push(
          `Failed to create blocks relation to ${target}: ${r.error}`,
        );
    }
  }

  if (args.blockedBy) {
    for (const source of args.blockedBy) {
      const r = await Result.tryPromise({
        try: async () =>
          client.createIssueRelation({
            issueId: source,
            relatedIssueId: issueId,
            type: IssueRelationType.Blocks,
          }),
        catch: (e) => errMsg(e),
      });
      if (Result.isError(r))
        warnings.push(
          `Failed to create blockedBy relation from ${source}: ${r.error}`,
        );
    }
  }

  if (args.relatedTo) {
    for (const target of args.relatedTo) {
      const r = await Result.tryPromise({
        try: async () =>
          client.createIssueRelation({
            issueId,
            relatedIssueId: target,
            type: IssueRelationType.Related,
          }),
        catch: (e) => errMsg(e),
      });
      if (Result.isError(r))
        warnings.push(
          `Failed to create related relation to ${target}: ${r.error}`,
        );
    }
  }

  if (args.duplicateOf) {
    const target = args.duplicateOf;
    const r = await Result.tryPromise({
      try: async () =>
        client.createIssueRelation({
          issueId,
          relatedIssueId: target,
          type: IssueRelationType.Duplicate,
        }),
      catch: (e) => errMsg(e),
    });
    if (Result.isError(r))
      warnings.push(`Failed to create duplicate relation: ${r.error}`);
  }
}
