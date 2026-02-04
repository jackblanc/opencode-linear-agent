/**
 * Linear tools — re-exports all tool definitions as a single object.
 */

import { issueTools } from "./issues";
import { commentTools } from "./comments";
import { projectTools } from "./projects";
import { graphqlTools } from "./graphql";

export const linearTools = {
  ...issueTools,
  ...commentTools,
  ...projectTools,
  ...graphqlTools,
};
