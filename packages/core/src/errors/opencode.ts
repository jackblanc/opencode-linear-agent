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
export class OpencodeProviderAuthError extends TaggedError(
  "OpencodeProviderAuthError",
)<{
  providerID: string;
  reason: string;
  message: string;
}>() {
  constructor(args: { providerID: string; reason: string }) {
    super({
      ...args,
      message: `Provider auth failed for ${args.providerID}: ${args.reason}`,
    });
  }
}

/**
 * OpenCode API error
 */
export class OpencodeApiError extends TaggedError("OpencodeApiError")<{
  statusCode: number | undefined;
  reason: string;
  isRetryable: boolean;
  message: string;
}>() {
  constructor(args: {
    statusCode: number | undefined;
    reason: string;
    isRetryable: boolean;
  }) {
    super({
      ...args,
      message: `API error${args.statusCode ? ` (${args.statusCode})` : ""}: ${args.reason}`,
    });
  }
}

/**
 * Message was aborted
 */
export class OpencodeMessageAbortedError extends TaggedError(
  "OpencodeMessageAbortedError",
)<{
  reason: string;
  message: string;
}>() {
  constructor(args: { reason: string }) {
    super({ ...args, message: `Message aborted: ${args.reason}` });
  }
}

/**
 * Message output exceeded length limit
 */
export class OpencodeOutputLengthError extends TaggedError(
  "OpencodeOutputLengthError",
)<{
  message: string;
}>() {
  constructor() {
    super({ message: "Message output exceeded length limit" });
  }
}

/**
 * Unknown OpenCode error
 */
export class OpencodeUnknownError extends TaggedError("OpencodeUnknownError")<{
  reason: string;
  message: string;
}>() {
  constructor(args: { reason: string }) {
    super({ ...args, message: `Unknown OpenCode error: ${args.reason}` });
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
        return new OpencodeProviderAuthError({
          providerID: error.data.providerID,
          reason: error.data.message,
        });

      case "APIError":
        return new OpencodeApiError({
          statusCode: error.data.statusCode,
          reason: error.data.message,
          isRetryable: error.data.isRetryable,
        });

      case "MessageAbortedError":
        return new OpencodeMessageAbortedError({ reason: error.data.message });

      case "MessageOutputLengthError":
        return new OpencodeOutputLengthError();

      case "UnknownError":
        return new OpencodeUnknownError({ reason: error.data.message });
    }
  }

  // Fallback for other error shapes
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);

  return new OpencodeUnknownError({ reason: message });
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
