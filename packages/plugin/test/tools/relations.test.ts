/* eslint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/promise-function-async */
import { describe, test, expect } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { IssueRelationType } from "@linear/sdk";
import { syncRelations } from "../../src/tools/relations";

interface MockRelation {
  id: string;
  type: string;
  relatedIssue?: { id: string; identifier: string; title: string };
  issue?: { id: string; identifier: string; title: string };
}

function mockClient(opts: {
  relations?: MockRelation[];
  inverseRelations?: MockRelation[];
  deleted?: string[];
  created?: Array<{ issueId: string; relatedIssueId: string; type: string }>;
  failCreate?: boolean;
}): LinearClient {
  const deleted = opts.deleted ?? [];
  const created =
    opts.created ??
    ([] as Array<{ issueId: string; relatedIssueId: string; type: string }>);

  return {
    issue: () =>
      Promise.resolve({
        relations: () => Promise.resolve({ nodes: opts.relations ?? [] }),
        inverseRelations: () =>
          Promise.resolve({ nodes: opts.inverseRelations ?? [] }),
      }),
    deleteIssueRelation: (id: string) => {
      deleted.push(id);
      return Promise.resolve({});
    },
    createIssueRelation: (input: {
      issueId: string;
      relatedIssueId: string;
      type: string;
    }) => {
      if (opts.failCreate) {
        return Promise.reject(new Error("API error"));
      }
      created.push(input);
      return Promise.resolve({});
    },
  } as unknown as LinearClient;
}

describe("syncRelations", () => {
  test("no-op when no relation args provided", async () => {
    const deleted: string[] = [];
    const created: Array<{
      issueId: string;
      relatedIssueId: string;
      type: string;
    }> = [];
    const warnings: string[] = [];
    const client = mockClient({ deleted, created });
    await syncRelations(client, "issue-1", {}, warnings);
    expect(deleted).toEqual([]);
    expect(created).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("deletes existing blocks relations when blocks arg provided", async () => {
    const deleted: string[] = [];
    const created: Array<{
      issueId: string;
      relatedIssueId: string;
      type: string;
    }> = [];
    const warnings: string[] = [];
    const client = mockClient({
      relations: [
        { id: "rel-1", type: "blocks" },
        { id: "rel-2", type: "related" },
      ],
      inverseRelations: [],
      deleted,
      created,
    });
    await syncRelations(client, "issue-1", { blocks: ["target-1"] }, warnings);
    expect(deleted).toEqual(["rel-1"]);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      issueId: "issue-1",
      relatedIssueId: "target-1",
      type: IssueRelationType.Blocks,
    });
  });

  test("blockedBy creates inverse blocks relation", async () => {
    const deleted: string[] = [];
    const created: Array<{
      issueId: string;
      relatedIssueId: string;
      type: string;
    }> = [];
    const warnings: string[] = [];
    const client = mockClient({
      relations: [],
      inverseRelations: [],
      deleted,
      created,
    });
    await syncRelations(
      client,
      "issue-1",
      { blockedBy: ["blocker-1"] },
      warnings,
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      issueId: "blocker-1",
      relatedIssueId: "issue-1",
      type: IssueRelationType.Blocks,
    });
  });

  test("deletes inverse blocks when blockedBy arg provided", async () => {
    const deleted: string[] = [];
    const created: Array<{
      issueId: string;
      relatedIssueId: string;
      type: string;
    }> = [];
    const warnings: string[] = [];
    const client = mockClient({
      relations: [],
      inverseRelations: [
        { id: "inv-1", type: "blocks" },
        { id: "inv-2", type: "duplicate" },
      ],
      deleted,
      created,
    });
    await syncRelations(client, "issue-1", { blockedBy: [] }, warnings);
    expect(deleted).toEqual(["inv-1"]);
    expect(created).toEqual([]);
  });

  test("creates related relations", async () => {
    const created: Array<{
      issueId: string;
      relatedIssueId: string;
      type: string;
    }> = [];
    const warnings: string[] = [];
    const client = mockClient({
      relations: [],
      inverseRelations: [],
      created,
    });
    await syncRelations(
      client,
      "issue-1",
      { relatedTo: ["rel-a", "rel-b"] },
      warnings,
    );
    expect(created).toHaveLength(2);
    expect(created[0]?.type).toBe(IssueRelationType.Related);
    expect(created[1]?.type).toBe(IssueRelationType.Related);
  });

  test("creates duplicate relation", async () => {
    const created: Array<{
      issueId: string;
      relatedIssueId: string;
      type: string;
    }> = [];
    const warnings: string[] = [];
    const client = mockClient({
      relations: [],
      inverseRelations: [],
      created,
    });
    await syncRelations(client, "issue-1", { duplicateOf: "dup-1" }, warnings);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      issueId: "issue-1",
      relatedIssueId: "dup-1",
      type: IssueRelationType.Duplicate,
    });
  });

  test("pushes warning on failed relation creation", async () => {
    const warnings: string[] = [];
    const client = mockClient({
      relations: [],
      inverseRelations: [],
      failCreate: true,
    });
    await syncRelations(client, "issue-1", { blocks: ["target-1"] }, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Failed to create blocks relation");
    expect(warnings[0]).toContain("target-1");
  });

  test("preserves unrelated relation types when replacing", async () => {
    const deleted: string[] = [];
    const warnings: string[] = [];
    const client = mockClient({
      relations: [
        { id: "rel-blocks", type: "blocks" },
        { id: "rel-related", type: "related" },
        { id: "rel-dup", type: "duplicate" },
      ],
      inverseRelations: [],
      deleted,
    });
    await syncRelations(
      client,
      "issue-1",
      { blocks: ["new-target"] },
      warnings,
    );
    expect(deleted).toEqual(["rel-blocks"]);
  });
});
