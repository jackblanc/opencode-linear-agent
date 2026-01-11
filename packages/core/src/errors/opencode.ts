import { TaggedError } from "better-result";
import type {
  ProviderAuthError,
  UnknownError,
  MessageOutputLengthError,
  MessageAbortedError,
  ApiError,
} from "@opencode-ai/sdk/v2";

/**
 * OpenCode provider authentication error
 */
export class OpencodeProviderAuthError extends TaggedError {
  readonly _tag = "OpencodeProviderAuthError" as const;
  constructor(
    readonly providerID: string,
    readonly reason: string,
  ) {
    super(`Provider auth failed for ${providerID}: ${reason}`);
  }
}

/**
 * OpenCode API error
 */
export class OpencodeApiError extends TaggedError {
  readonly _tag = "OpencodeApiError" as const;
  constructor(
    readonly statusCode: number | undefined,
    readonly reason: string,
    readonly isRetryable: boolean,
  ) {
    super(`API error${statusCode ? ` (${statusCode})` : ""}: ${reason}`);
  }
}

/**
 * Message was aborted
 */
export class OpencodeMessageAbortedError extends TaggedError {
  readonly _tag = "OpencodeMessageAbortedError" as const;
  constructor(readonly reason: string) {
    super(`Message aborted: ${reason}`);
  }
}

/**
 * Message output exceeded length limit
 */
export class OpencodeOutputLengthError extends TaggedError {
  readonly _tag = "OpencodeOutputLengthError" as const;
  constructor() {
    super("Message output exceeded length limit");
  }
}

/**
 * Unknown OpenCode error
 */
export class OpencodeUnknownError extends TaggedError {
  readonly _tag = "OpencodeUnknownError" as const;
  constructor(readonly reason: string) {
    super(`Unknown OpenCode error: ${reason}`);
  }
}

/**
 * Union of all OpenCode error types
 */
export type OpencodeServiceError =
  | OpencodeProviderAuthError
  | OpencodeApiError
  | OpencodeMessageAbortedError
  | OpencodeOutputLengthError
  | OpencodeUnknownError;

/**
 * OpenCode SDK error object shape
 */
type OpencodeErrorObject =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | ApiError;

/**
 * Type guard for OpenCode SDK error objects
 */
function isOpencodeErrorObject(error: unknown): error is OpencodeErrorObject {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as { name: unknown }).name === "string" &&
    typeof (error as { data: unknown }).data === "object"
  );
}

/**
 * Map an OpenCode SDK error to a TaggedError
 */
export function mapOpencodeError(error: unknown): OpencodeServiceError {
  // Handle SDK error objects with `name` discriminator
  if (isOpencodeErrorObject(error)) {
    switch (error.name) {
      case "ProviderAuthError":
        return new OpencodeProviderAuthError(
          error.data.providerID,
          error.data.message,
        );

      case "APIError":
        return new OpencodeApiError(
          error.data.statusCode,
          error.data.message,
          error.data.isRetryable,
        );

      case "MessageAbortedError":
        return new OpencodeMessageAbortedError(error.data.message);

      case "MessageOutputLengthError":
        return new OpencodeOutputLengthError();

      case "UnknownError":
        return new OpencodeUnknownError(error.data.message);
    }
  }

  // Fallback for other error shapes
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);

  return new OpencodeUnknownError(message);
}

/**
 * Extract error message from an OpenCode SDK error object
 *
 * This is a simpler helper for cases where we just need the error message
 * string rather than a full typed error.
 */
export function getOpencodeErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}
