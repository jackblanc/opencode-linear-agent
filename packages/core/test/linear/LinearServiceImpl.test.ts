import { describe, test, expect } from "bun:test";
import { Result } from "better-result";
import { LinearServiceImpl } from "../../src/linear/LinearServiceImpl";

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
