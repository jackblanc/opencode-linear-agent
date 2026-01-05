import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  proxyToOpencode,
  type OpencodeServer,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  SandboxProvider,
  SandboxContext,
  ExecResult,
  ExecOptions,
  OpencodeServerConfig,
} from "../types";

/**
 * Shared sandbox ID for all OpenCode access (web UI and Linear webhooks)
 */
const SANDBOX_ID = "opencode-instance";

/**
 * Port used by OpenCode server (default)
 */
const OPENCODE_PORT = 4096;

/**
 * Cloudflare Sandbox implementation of SandboxProvider
 *
 * Generic over TEnv to properly type the DurableObjectNamespace binding
 * from the worker's generated Env type.
 */
export class CloudflareSandbox<TEnv> implements SandboxProvider {
  private sandbox: Sandbox<TEnv> | null = null;
  private server: OpencodeServer | null = null;

  constructor(
    private readonly sandboxBinding: DurableObjectNamespace<Sandbox<TEnv>>,
    private readonly envVars: Record<string, string>,
  ) {}

  private getSandbox(): Sandbox<TEnv> {
    this.sandbox ??= getSandbox(this.sandboxBinding, SANDBOX_ID);
    return this.sandbox;
  }

  async getOpencodeClient(
    _organizationId: string,
    workdir: string,
    config?: OpencodeServerConfig,
  ): Promise<SandboxContext> {
    const sandbox = this.getSandbox();

    console.info(`[sandbox] Starting container`);
    await sandbox.start();
    console.info(`[sandbox] Container is running`);

    // Set environment variables
    console.info(`[sandbox] Setting environment variables`);
    await sandbox.setEnvVars(this.envVars);

    // Ensure directory exists
    console.info(`[sandbox] Ensuring directory exists: ${workdir}`);
    await sandbox.exec(`mkdir -p ${workdir}`, { timeout: 30000 });

    // Create OpenCode client and server
    const port = config?.port ?? OPENCODE_PORT;
    console.info(
      `[sandbox] Creating OpenCode client and server on port ${port}`,
    );

    const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
      port,
      directory: workdir,
      config: config?.config,
    });

    this.server = server;

    console.info(`[sandbox] Sandbox initialized successfully`);
    return { client, server };
  }

  async proxyToOpencode(
    _organizationId: string,
    request: Request,
  ): Promise<Response> {
    const sandbox = this.getSandbox();

    if (!this.server) {
      throw new Error("Sandbox not initialized. Call getOpencodeClient first.");
    }

    return proxyToOpencode(request, sandbox, this.server);
  }

  async exec(
    _organizationId: string,
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const sandbox = this.getSandbox();
    return sandbox.exec(command, options);
  }

  async exists(_organizationId: string, path: string): Promise<boolean> {
    const sandbox = this.getSandbox();
    const result = await sandbox.exists(path);
    return result.exists;
  }

  async setEnvVars(
    _organizationId: string,
    vars: Record<string, string>,
  ): Promise<void> {
    const sandbox = this.getSandbox();
    await sandbox.setEnvVars(vars);
  }

  async wsConnect(
    _organizationId: string,
    request: Request,
    port: number,
  ): Promise<Response> {
    const sandbox = this.getSandbox();
    return sandbox.wsConnect(request, port);
  }
}
