import { TaggedError } from "better-result";
import {
  LinearError,
  InvalidInputLinearError,
  RatelimitedLinearError,
  AuthenticationLinearError,
  ForbiddenLinearError,
  NetworkLinearError,
  FeatureNotAccessibleLinearError,
} from "@linear/sdk";
import type { LinearGraphQLError } from "@linear/sdk";

/**
 * Base context for all Linear errors
 */
interface LinearErrorContext {
  cause?: LinearError;
  graphqlErrors?: LinearGraphQLError[];
  status?: number;
  query?: string;
  variables?: Record<string, unknown>;
}

/**
 * Resource not found in Linear
 */
export class LinearNotFoundError extends TaggedError {
  readonly _tag = "LinearNotFoundError" as const;
  constructor(
    readonly resourceType: string,
    readonly resourceId: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`${resourceType} not found: ${resourceId}`);
  }
}

/**
 * Invalid input provided to Linear API
 */
export class LinearInvalidInputError extends TaggedError {
  readonly _tag = "LinearInvalidInputError" as const;
  constructor(
    readonly field: string,
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Invalid input for ${field}: ${reason}`);
  }
}

/**
 * Rate limited by Linear API
 */
export class LinearRateLimitError extends TaggedError {
  readonly _tag = "LinearRateLimitError" as const;
  constructor(
    readonly retryAfter?: number,
    readonly context?: LinearErrorContext,
  ) {
    super(`Rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""}`);
  }
}

/**
 * Authentication failed with Linear
 */
export class LinearAuthError extends TaggedError {
  readonly _tag = "LinearAuthError" as const;
  constructor(
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Authentication failed: ${reason}`);
  }
}

/**
 * Forbidden - insufficient permissions
 */
export class LinearForbiddenError extends TaggedError {
  readonly _tag = "LinearForbiddenError" as const;
  constructor(
    readonly resource: string,
    readonly action: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Forbidden: cannot ${action} ${resource}`);
  }
}

/**
 * Network error communicating with Linear
 */
export class LinearNetworkError extends TaggedError {
  readonly _tag = "LinearNetworkError" as const;
  constructor(
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Network error: ${reason}`);
  }
}

/**
 * Feature not accessible (plan limitation)
 */
export class LinearFeatureNotAccessibleError extends TaggedError {
  readonly _tag = "LinearFeatureNotAccessibleError" as const;
  constructor(
    readonly feature: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Feature not accessible: ${feature}`);
  }
}

/**
 * Unknown Linear error
 */
export class LinearUnknownError extends TaggedError {
  readonly _tag = "LinearUnknownError" as const;
  constructor(
    readonly reason: string,
    readonly context?: LinearErrorContext,
  ) {
    super(`Unknown Linear error: ${reason}`);
  }
}

/**
 * Union of all Linear error types
 */
export type LinearServiceError =
  | LinearNotFoundError
  | LinearInvalidInputError
  | LinearRateLimitError
  | LinearAuthError
  | LinearForbiddenError
  | LinearNetworkError
  | LinearFeatureNotAccessibleError
  | LinearUnknownError;

/**
 * Map a Linear SDK error to a TaggedError
 */
export function mapLinearError(error: unknown): LinearServiceError {
  const context: LinearErrorContext = {};

  if (error instanceof LinearError) {
    context.cause = error;
    context.status = error.status;
    context.query = error.query;
    context.variables = error.variables;
    context.graphqlErrors = error.errors;
  }

  if (error instanceof InvalidInputLinearError) {
    const field = error.errors?.[0]?.path?.join(".") ?? "unknown";
    const reason = error.errors?.[0]?.message ?? error.message;
    return new LinearInvalidInputError(field, reason, context);
  }

  if (error instanceof RatelimitedLinearError) {
    return new LinearRateLimitError(undefined, context);
  }

  if (error instanceof AuthenticationLinearError) {
    return new LinearAuthError(error.message, context);
  }

  if (error instanceof ForbiddenLinearError) {
    return new LinearForbiddenError("resource", "access", context);
  }

  if (error instanceof NetworkLinearError) {
    return new LinearNetworkError(error.message, context);
  }

  if (error instanceof FeatureNotAccessibleLinearError) {
    return new LinearFeatureNotAccessibleError("unknown", context);
  }

  // Unknown error
  const message = error instanceof Error ? error.message : String(error);
  return new LinearUnknownError(message, context);
}
