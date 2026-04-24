import type { ApplicationConfig } from "@opencode-linear-agent/core";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ServerRuntime } from "../src/index";

import { startServer, stopServer } from "../src/index";

const config: ApplicationConfig = {
  webhookServerPublicHostname: "example.com",
  webhookServerPort: 0,
  opencodeServerUrl: "http://localhost:4096",
  linearClientId: "client-id",
  linearClientSecret: "client-secret",
  linearWebhookSecret: "test-secret",
};

let runtime: ServerRuntime | null = null;

function port(address: string | AddressInfo | null): number {
  if (address && typeof address === "object") {
    return address.port;
  }

  throw new Error("server did not bind to an address");
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  if (runtime) {
    await stopServer(runtime);
    runtime = null;
  }
  vi.restoreAllMocks();
});

describe("server runtime", () => {
  test("starts a Node HTTP server in process", async () => {
    runtime = startServer(config);

    const response = await fetch(`http://127.0.0.1:${port(runtime.server.address())}/missing`);

    expect(response.status).toBe(404);
    expect(runtime.tokenRefreshTimer).toBeNull();
  });
});
