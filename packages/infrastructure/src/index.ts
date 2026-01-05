/**
 * Infrastructure package - platform-specific implementations
 *
 * This package contains:
 * - Cloudflare implementations (KV, Queue, Sandbox)
 * - Linear API adapter
 * - Interfaces for all infrastructure abstractions
 *
 * This is the ONLY package that imports @cloudflare/* modules.
 * Workers should re-export Sandbox from this package for wrangler bindings.
 */

// Re-export Sandbox class and helpers for workers to use
export { Sandbox, getSandbox } from "@cloudflare/sandbox";
export { createOpencode, proxyToOpencode } from "@cloudflare/sandbox/opencode";

// Interfaces
export type {
  SandboxProvider,
  SandboxContext,
  OpencodeServerConfig,
  Queue,
  KeyValueStore,
  TokenStore,
  RefreshTokenData,
  ExecResult,
  ExecOptions,
} from "./types";

// Cloudflare implementations
export {
  KVStore,
  KVSessionRepository,
  KVTokenStore,
  CloudflareSandbox,
  SandboxGitOperations,
} from "./cloudflare";

// Linear adapter
export { LinearClientAdapter } from "./LinearClientAdapter";
