/**
 * Infrastructure interfaces - abstractions for platform-specific resources
 */

import type { OpencodeClient, Config } from "@opencode-ai/sdk";

/**
 * Result of command execution
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for command execution
 */
export interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

/**
 * Configuration for OpenCode server
 */
export interface OpencodeServerConfig {
  port?: number;
  directory?: string;
  config?: Config;
}

/**
 * Context returned when initializing a sandbox
 */
export interface SandboxContext {
  client: OpencodeClient;
  server: { port: number };
}

/**
 * Provider for sandbox operations
 * Abstracts Cloudflare Sandbox completely
 */
export interface SandboxProvider {
  /**
   * Get an OpenCode client for the given organization
   * Creates/starts the sandbox if needed
   */
  getOpencodeClient(
    organizationId: string,
    workdir: string,
    config?: OpencodeServerConfig,
  ): Promise<SandboxContext>;

  /**
   * Proxy an HTTP request to the sandbox's OpenCode UI
   */
  proxyToOpencode(organizationId: string, request: Request): Promise<Response>;

  /**
   * Execute a command in the sandbox
   */
  exec(
    organizationId: string,
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult>;

  /**
   * Check if a path exists in the sandbox
   */
  exists(organizationId: string, path: string): Promise<boolean>;

  /**
   * Set environment variables in the sandbox
   */
  setEnvVars(
    organizationId: string,
    vars: Record<string, string>,
  ): Promise<void>;

  /**
   * Handle WebSocket upgrade for the sandbox
   */
  wsConnect(
    organizationId: string,
    request: Request,
    port: number,
  ): Promise<Response>;
}

/**
 * Generic queue interface
 */
export interface Queue<T> {
  /**
   * Send a message to the queue
   */
  send(message: T): Promise<void>;
}

/**
 * Generic key-value store interface
 */
export interface KeyValueStore {
  /**
   * Get a value by key
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Get a value as a string
   */
  getString(key: string): Promise<string | null>;

  /**
   * Put a value
   */
  put(
    key: string,
    value: unknown,
    options?: { expirationTtl?: number },
  ): Promise<void>;

  /**
   * Delete a key
   */
  delete(key: string): Promise<void>;
}

/**
 * Token store for OAuth tokens
 */
export interface TokenStore {
  /**
   * Get access token for an organization
   */
  getAccessToken(organizationId: string): Promise<string | null>;

  /**
   * Set access token for an organization
   */
  setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void>;

  /**
   * Get refresh token data for an organization
   */
  getRefreshTokenData(organizationId: string): Promise<RefreshTokenData | null>;

  /**
   * Set refresh token data for an organization
   */
  setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void>;
}

/**
 * Refresh token storage structure
 */
export interface RefreshTokenData {
  refreshToken: string;
  appId: string;
  organizationId: string;
  installedAt: string;
  workspaceName?: string;
}
