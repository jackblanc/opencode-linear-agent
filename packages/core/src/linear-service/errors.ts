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
 * Invalid input provided to Linear API
 */
class LinearInvalidInputError extends TaggedError("LinearInvalidInputError")<{
  field: string;
  reason: string;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: {
    field: string;
    reason: string;
    context?: LinearErrorContext;
  }) {
    super({
      ...args,
      message: `Invalid input for ${args.field}: ${args.reason}`,
    });
  }
}

/**
 * Rate limited by Linear API
 */
class LinearRateLimitError extends TaggedError("LinearRateLimitError")<{
  retryAfter?: number;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: { retryAfter?: number; context?: LinearErrorContext }) {
    super({
      ...args,
      message: `Rate limited${args.retryAfter ? `, retry after ${args.retryAfter}s` : ""}`,
    });
  }
}

/**
 * Authentication failed with Linear
 */
class LinearAuthError extends TaggedError("LinearAuthError")<{
  reason: string;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: { reason: string; context?: LinearErrorContext }) {
    super({ ...args, message: `Authentication failed: ${args.reason}` });
  }
}

/**
 * Forbidden - insufficient permissions
 */
export class LinearForbiddenError extends TaggedError("LinearForbiddenError")<{
  resource: string;
  action: string;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: {
    resource: string;
    action: string;
    context?: LinearErrorContext;
  }) {
    super({
      ...args,
      message: `Forbidden: cannot ${args.action} ${args.resource}`,
    });
  }
}

/**
 * Network error communicating with Linear
 */
class LinearNetworkError extends TaggedError("LinearNetworkError")<{
  reason: string;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: { reason: string; context?: LinearErrorContext }) {
    super({ ...args, message: `Network error: ${args.reason}` });
  }
}

/**
 * Feature not accessible (plan limitation)
 */
class LinearFeatureNotAccessibleError extends TaggedError(
  "LinearFeatureNotAccessibleError",
)<{
  feature: string;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: { feature: string; context?: LinearErrorContext }) {
    super({ ...args, message: `Feature not accessible: ${args.feature}` });
  }
}

/**
 * Unknown Linear error
 */
class LinearUnknownError extends TaggedError("LinearUnknownError")<{
  reason: string;
  context?: LinearErrorContext;
  message: string;
}>() {
  constructor(args: { reason: string; context?: LinearErrorContext }) {
    super({ ...args, message: `Unknown Linear error: ${args.reason}` });
  }
}

/**
 * Map a Linear SDK error to a TaggedError
 */
export function mapLinearError(error: unknown) {
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
    return new LinearInvalidInputError({ field, reason, context });
  }

  if (error instanceof RatelimitedLinearError) {
    return new LinearRateLimitError({ context });
  }

  if (error instanceof AuthenticationLinearError) {
    return new LinearAuthError({ reason: error.message, context });
  }

  if (error instanceof ForbiddenLinearError) {
    return new LinearForbiddenError({
      resource: "resource",
      action: "access",
      context,
    });
  }

  if (error instanceof NetworkLinearError) {
    return new LinearNetworkError({ reason: error.message, context });
  }

  if (error instanceof FeatureNotAccessibleLinearError) {
    return new LinearFeatureNotAccessibleError({ feature: "unknown", context });
  }

  // Unknown error
  const message = error instanceof Error ? error.message : String(error);
  return new LinearUnknownError({ reason: message, context });
}
