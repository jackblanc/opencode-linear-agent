import { TaggedError } from "better-result";

/**
 * Git fetch operation failed
 */
export class GitFetchError extends TaggedError("GitFetchError")<{
  remote: string;
  branch: string;
  reason: string;
  message: string;
}>() {
  constructor(args: { remote: string; branch: string; reason: string }) {
    super({
      ...args,
      message: `Failed to fetch ${args.remote}/${args.branch}: ${args.reason}`,
    });
  }
}

/**
 * Git worktree creation failed
 */
export class GitWorktreeError extends TaggedError("GitWorktreeError")<{
  branch: string;
  directory: string;
  reason: string;
  message: string;
}>() {
  constructor(args: { branch: string; directory: string; reason: string }) {
    super({
      ...args,
      message: `Failed to create worktree for branch ${args.branch} at ${args.directory}: ${args.reason}`,
    });
  }
}

/**
 * Could not determine the default branch (main/master)
 */
export class GitDefaultBranchError extends TaggedError(
  "GitDefaultBranchError",
)<{
  remote: string;
  reason: string;
  message: string;
}>() {
  constructor(args: { remote: string; reason: string }) {
    super({
      ...args,
      message: `Could not determine default branch for ${args.remote}: ${args.reason}`,
    });
  }
}

/**
 * Not a git repository
 */
export class GitNotRepoError extends TaggedError("GitNotRepoError")<{
  directory: string;
  message: string;
}>() {
  constructor(args: { directory: string }) {
    super({
      ...args,
      message: `${args.directory} is not a git repository`,
    });
  }
}

/**
 * Union of all Git error types
 */
export type GitServiceError =
  | GitFetchError
  | GitWorktreeError
  | GitDefaultBranchError
  | GitNotRepoError;
