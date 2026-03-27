import { createIssueTools } from "./issues";
import { createCommentTools } from "./comments";
import { createProjectTools } from "./projects";
import { createGraphqlTools } from "./graphql";
import type { LinearClient } from "@linear/sdk";
import type { Result } from "better-result";

export type GetLinearClient = () => Promise<Result<LinearClient, string>>;

export function createLinearTools(getLinearClient: GetLinearClient) {
  return {
    ...createIssueTools(getLinearClient),
    ...createCommentTools(getLinearClient),
    ...createProjectTools(getLinearClient),
    ...createGraphqlTools(getLinearClient),
  };
}
