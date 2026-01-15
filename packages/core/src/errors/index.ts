// Re-export all error types and utilities
export * from "./linear";
export * from "./opencode";

// Re-export TaggedError and matching utilities for convenience
export {
  TaggedError,
  matchError,
  matchErrorPartial,
  isTaggedError,
} from "better-result";
