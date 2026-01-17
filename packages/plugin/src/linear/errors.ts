/**
 * Tagged error types for Linear API operations.
 */

import { TaggedError } from "better-result";

/**
 * Error when Linear API returns an error response
 */
export class LinearApiError extends TaggedError("LinearApiError")<{
  operation: string;
  message: string;
  cause?: unknown;
}>() {
  constructor(args: { operation: string; cause?: unknown }) {
    const msg =
      args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({ ...args, message: `Linear API ${args.operation} failed: ${msg}` });
  }
}

/**
 * Union of all Linear service errors
 */
export type LinearServiceError = LinearApiError;
