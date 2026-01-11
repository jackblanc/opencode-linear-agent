import { type Plugin, tool } from "@opencode-ai/plugin";

/**
 * Linear GraphQL Plugin
 *
 * Adds a custom tool to execute GraphQL queries and mutations against
 * the Linear API. This enables operations not supported by the Linear MCP,
 * such as creating agent sessions programmatically.
 *
 * Authentication is read from the Linear MCP auth file.
 */
export const LinearGraphQLPlugin: Plugin = async () => {
  return {
    tool: {
      "linear-graphql": tool({
        description:
          "Execute a GraphQL query or mutation against the Linear API. " +
          "Use this for operations not available in the Linear MCP tools, " +
          "such as creating agent sessions with agentSessionCreateOnIssue.",
        args: {
          query: tool.schema
            .string()
            .describe("The GraphQL query or mutation to execute"),
          variables: tool.schema
            .string()
            .optional()
            .describe("Optional JSON string of variables for the query"),
        },
        async execute(args) {
          // Read Linear API key from MCP auth file
          const authPath = `${process.env.HOME}/.local/share/opencode/mcp-auth.json`;
          let apiKey: string | undefined;

          try {
            const authFile = await Bun.file(authPath).text();
            const auth = JSON.parse(authFile);
            // Linear MCP stores token under the server name
            apiKey = auth?.linear?.LINEAR_API_KEY;
          } catch {
            // Auth file doesn't exist or is malformed
          }

          if (!apiKey) {
            return JSON.stringify({
              error:
                "No Linear API key found. Run 'opencode mcp auth linear' to authenticate.",
            });
          }

          // Parse variables if provided
          let variables: Record<string, unknown> | undefined;
          if (args.variables) {
            try {
              variables = JSON.parse(args.variables);
            } catch (e) {
              return JSON.stringify({
                error: `Invalid JSON in variables: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }

          // Execute GraphQL request
          const response = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: apiKey,
            },
            body: JSON.stringify({
              query: args.query,
              variables,
            }),
          });

          if (!response.ok) {
            return JSON.stringify({
              error: `Linear API error: ${response.status} ${response.statusText}`,
            });
          }

          const result = await response.json();
          return JSON.stringify(result, null, 2);
        },
      }),
    },
  };
};
