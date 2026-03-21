/**
 * Linear GraphQL tool for raw readonly queries.
 */

import { tool } from "@opencode-ai/plugin";
import { Result } from "better-result";
import type { GetLinearClient } from "./utils";
import { errorJson, errMsg } from "./utils";

const z = tool.schema;

export function createGraphqlTools(getClient: GetLinearClient) {
  return {
    linear_graphql: tool({
      description:
        "Execute a raw readonly GraphQL query against the Linear API. Use for advanced queries not covered by other tools (e.g., agent session activities).",
      args: {
        query: z
          .string()
          .describe("GraphQL query string (must be a query, not mutation)"),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables for the GraphQL query"),
      },
      async execute(args): Promise<string> {
        const query = args.query.trim();

        if (
          query.startsWith("mutation") ||
          query.includes("mutation ") ||
          query.includes("mutation{")
        ) {
          return errorJson(
            "Only readonly queries are allowed. Mutations are not permitted.",
          );
        }

        if (
          query.startsWith("subscription") ||
          query.includes("subscription ")
        ) {
          return errorJson("Subscriptions are not supported.");
        }

        const clientResult = await getClient();
        if (Result.isError(clientResult)) return errorJson(clientResult.error);
        const client = clientResult.value;

        const result = await Result.tryPromise({
          try: async () => {
            const response = await client.client.rawRequest<
              unknown,
              Record<string, unknown>
            >(query, args.variables);
            return JSON.stringify(response.data, null, 2);
          },
          catch: (e) => errMsg(e),
        });

        return Result.isError(result) ? errorJson(result.error) : result.value;
      },
    }),
  };
}
