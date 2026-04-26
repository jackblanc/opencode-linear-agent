import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
} from "@linear/sdk/webhooks";
import type {
  ApplicationConfig,
  AgentStateNamespace,
  AuthRepository,
  OpencodeService,
} from "@opencode-linear-agent/core";

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import {
  LinearEventProcessor,
  LinearService,
  IssueEventHandler,
  Log,
} from "@opencode-linear-agent/core";
import { Hono } from "hono";

import { getLinearAccessToken } from "../../token";

async function getLinearService(
  config: ApplicationConfig,
  authRepository: AuthRepository,
  event: AgentSessionEventWebhookPayload | EntityWebhookPayloadWithIssueData,
) {
  if (config.linearOrganizationId && event.organizationId !== config.linearOrganizationId) {
    throw new Error(
      `Organization ID mismatch: expected ${config.linearOrganizationId}, got ${event.organizationId}`,
    );
  }
  const accessTokenResult = await getLinearAccessToken(
    authRepository,
    {
      clientId: config.linearClientId,
      clientSecret: config.linearClientSecret,
    },
    event.organizationId,
  );
  if (accessTokenResult.isErr()) {
    throw accessTokenResult.error;
  }
  return new LinearService(accessTokenResult.value);
}

export function createWebhookApp(
  config: ApplicationConfig,
  authRepository: AuthRepository,
  agentState: AgentStateNamespace,
  opencode: OpencodeService,
) {
  const app = new Hono();
  const linearWebhookClient = new LinearWebhookClient(config.linearWebhookSecret);
  const handler = linearWebhookClient.createHandler();
  handler.on("AgentSessionEvent", async (event) => {
    const linearService = await getLinearService(config, authRepository, event);
    const processor = new LinearEventProcessor(agentState, opencode, linearService, {
      organizationId: event.organizationId,
      opencodeUrl: config.opencodeServerUrl,
    });
    void processor.process(event).catch((e: unknown) => {
      Log.create({ service: "webhook" }).error("Failed to process event", {
        error: e,
      });
    });
  });

  handler.on("Issue", async (event) => {
    const linearService = await getLinearService(config, authRepository, event);
    const issueHandler = new IssueEventHandler(linearService, opencode, agentState);
    void issueHandler.process(event).catch((e: unknown) => {
      Log.create({ service: "webhook" }).error("Failed to handle issue event", {
        error: e,
      });
    });
  });

  app.post("/api/webhook/linear", async (c) => {
    return handler(c.req.raw);
  });

  return app;
}
