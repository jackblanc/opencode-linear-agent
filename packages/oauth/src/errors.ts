/**
 * Tagged errors for Linear OAuth operations.
 */

import { TaggedError } from "better-result";
import type { ZodError } from "zod";

export class MissingCredentialsError extends TaggedError(
  "MissingCredentialsError",
)<{
  message: string;
}>() {
  constructor() {
    super({
      message:
        "Missing LINEAR_CLIENT_ID or LINEAR_CLIENT_SECRET environment variables. " +
        "Please set these to your Linear OAuth app credentials.",
    });
  }
}

export class TokenExchangeError extends TaggedError("TokenExchangeError")<{
  status: number;
  message: string;
}>() {
  constructor(status: number) {
    super({ status, message: `Token exchange failed: ${status}` });
  }
}

export class TokenRefreshError extends TaggedError("TokenRefreshError")<{
  status: number;
  message: string;
}>() {
  constructor(status: number) {
    super({ status, message: `Token refresh failed: ${status}` });
  }
}

export class NotAuthenticatedError extends TaggedError(
  "NotAuthenticatedError",
)<{
  message: string;
}>() {
  constructor() {
    super({
      message: "Linear not authenticated.",
    });
  }
}

export class OAuthCallbackError extends TaggedError("OAuthCallbackError")<{
  reason: string;
  message: string;
}>() {
  constructor(reason: string) {
    super({ reason, message: `OAuth callback failed: ${reason}` });
  }
}

export class InvalidResponseError extends TaggedError("InvalidResponseError")<{
  message: string;
  issues: Array<{ path: string; message: string }>;
}>() {
  constructor(zodError: ZodError) {
    const issues = zodError.issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    }));
    super({
      message: `Invalid response from Linear API: ${zodError.message}`,
      issues,
    });
  }
}

export type LinearAuthError =
  | MissingCredentialsError
  | TokenExchangeError
  | TokenRefreshError
  | NotAuthenticatedError
  | OAuthCallbackError
  | InvalidResponseError;
