import { describe, test, expect } from "bun:test";
import { Result } from "better-result";
import { LinearServiceImpl } from "../../src/linear-service/LinearServiceImpl";

describe("LinearServiceImpl.getIssueAgentSessionIds", () => {
  test("paginates and dedupes agent session ids", async () => {
    const calls: Array<string | undefined> = [];
    const svc = new LinearServiceImpl("token");

    type Page = {
      nodes: Array<{ agentSessionId?: string | null }>;
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };

    const first: Page = {
      nodes: [
        { agentSessionId: "session-a" },
        { agentSessionId: "session-b" },
        { agentSessionId: null },
      ],
      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
    };
    const second: Page = {
      nodes: [{ agentSessionId: "session-b" }, { agentSessionId: "session-c" }],
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
    };
    const third: Page = {
      nodes: [
        { agentSessionId: undefined },
        { agentSessionId: "session-a" },
        { agentSessionId: "session-d" },
      ],
      pageInfo: { hasNextPage: false, endCursor: "cursor-3" },
    };

    const fakeClient = {
      issue: async (): Promise<{
        comments: (vars?: {
          after?: string;
          first?: number;
          includeArchived?: boolean;
        }) => Promise<Page>;
      }> => ({
        comments: async (vars?: {
          after?: string;
          first?: number;
          includeArchived?: boolean;
        }): Promise<Page> => {
          calls.push(vars?.after);
          switch (vars?.after) {
            case undefined:
              return first;
            case "cursor-1":
              return second;
            case "cursor-2":
              return third;
            default:
              return first;
          }
        },
      }),
    };

    Object.defineProperty(svc, "client", { value: fakeClient });

    const idsResult = await svc.getIssueAgentSessionIds("issue-1");
    expect(Result.isOk(idsResult)).toBe(true);
    if (Result.isError(idsResult)) {
      return;
    }

    expect(calls).toEqual([undefined, "cursor-1", "cursor-2"]);
    expect(idsResult.value.toSorted()).toEqual([
      "session-a",
      "session-b",
      "session-c",
      "session-d",
    ]);
  });
});

describe("LinearServiceImpl.moveIssueToInProgress", () => {
  const skippedTypes = [
    "started",
    "completed",
    "canceled",
    "triage",
    "backlog",
  ];

  test("moves unstarted issues to first started state", async () => {
    const updates: Array<{ stateId: string }> = [];
    const svc = new LinearServiceImpl("token");

    const fakeClient = {
      issue: async (): Promise<{
        state: Promise<{ id: string; name: string; type: string }>;
        team: Promise<{
          states: (_vars: { filter: { type: { eq: string } } }) => Promise<{
            nodes: Array<{ id: string; name: string; position: number }>;
          }>;
        }>;
        update: (input: { stateId: string }) => Promise<void>;
      }> => ({
        state: Promise.resolve({ id: "s1", name: "Todo", type: "unstarted" }),
        team: Promise.resolve({
          states: async (): Promise<{
            nodes: Array<{ id: string; name: string; position: number }>;
          }> => ({
            nodes: [
              { id: "s3", name: "Review", position: 2 },
              { id: "s2", name: "In Progress", position: 1 },
            ],
          }),
        }),
        update: async (input: { stateId: string }): Promise<void> => {
          updates.push(input);
        },
      }),
    };

    Object.defineProperty(svc, "client", { value: fakeClient });

    const result = await svc.moveIssueToInProgress("issue-1");

    expect(Result.isOk(result)).toBe(true);
    expect(updates).toEqual([{ stateId: "s2" }]);
  });

  for (const type of skippedTypes) {
    test(`does not move issues in '${type}' category`, async () => {
      const updates: Array<{ stateId: string }> = [];
      const stateCalls: Array<string> = [];
      const svc = new LinearServiceImpl("token");

      const fakeClient = {
        issue: async (): Promise<{
          state: Promise<{ id: string; name: string; type: string }>;
          team: Promise<{
            states: (_vars: { filter: { type: { eq: string } } }) => Promise<{
              nodes: Array<{ id: string; name: string; position: number }>;
            }>;
          }>;
          update: (input: { stateId: string }) => Promise<void>;
        }> => ({
          state: Promise.resolve({
            id: "s4",
            name: "Ready to merge",
            type,
          }),
          team: Promise.resolve({
            states: async (vars: {
              filter: { type: { eq: string } };
            }): Promise<{
              nodes: Array<{ id: string; name: string; position: number }>;
            }> => {
              stateCalls.push(vars.filter.type.eq);
              return { nodes: [] };
            },
          }),
          update: async (input: { stateId: string }): Promise<void> => {
            updates.push(input);
          },
        }),
      };

      Object.defineProperty(svc, "client", { value: fakeClient });

      const result = await svc.moveIssueToInProgress("issue-1");

      expect(Result.isOk(result)).toBe(true);
      expect(stateCalls).toEqual([]);
      expect(updates).toEqual([]);
    });
  }

  test("does not move issues with unknown category", async () => {
    const updates: Array<{ stateId: string }> = [];
    const stateCalls: Array<string> = [];
    const svc = new LinearServiceImpl("token");

    const fakeClient = {
      issue: async (): Promise<{
        state: Promise<{ id: string; name: string; type: string }>;
        team: Promise<{
          states: (_vars: { filter: { type: { eq: string } } }) => Promise<{
            nodes: Array<{ id: string; name: string; position: number }>;
          }>;
        }>;
        update: (input: { stateId: string }) => Promise<void>;
      }> => ({
        state: Promise.resolve({
          id: "s5",
          name: "Future State",
          type: "future",
        }),
        team: Promise.resolve({
          states: async (vars: {
            filter: { type: { eq: string } };
          }): Promise<{
            nodes: Array<{ id: string; name: string; position: number }>;
          }> => {
            stateCalls.push(vars.filter.type.eq);
            return { nodes: [] };
          },
        }),
        update: async (input: { stateId: string }): Promise<void> => {
          updates.push(input);
        },
      }),
    };

    Object.defineProperty(svc, "client", { value: fakeClient });

    const result = await svc.moveIssueToInProgress("issue-1");

    expect(Result.isOk(result)).toBe(true);
    expect(stateCalls).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("preserves unknown state types in getIssueState", async () => {
    const svc = new LinearServiceImpl("token");

    const fakeClient = {
      issue: async (): Promise<{
        state: Promise<{ id: string; name: string; type: string }>;
      }> => ({
        state: Promise.resolve({
          id: "s6",
          name: "Future State",
          type: "future",
        }),
      }),
    };

    Object.defineProperty(svc, "client", { value: fakeClient });

    const result = await svc.getIssueState("issue-1");

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value).toEqual({
      id: "s6",
      name: "Future State",
      type: "unknown",
    });
  });
});
