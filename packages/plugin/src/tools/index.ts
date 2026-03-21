/**
 * Linear tools — re-exports all tool definitions as a single object.
 */

import type { GetLinearClient } from "./utils";
import { createIssueTools } from "./issues";
import { createCommentTools } from "./comments";
import { createProjectTools } from "./projects";
import { createGraphqlTools } from "./graphql";

export function createLinearTools(getClient: GetLinearClient) {
  return {
    ...createIssueTools(getClient),
    ...createCommentTools(getClient),
    ...createProjectTools(getClient),
    ...createGraphqlTools(getClient),
  };
}
