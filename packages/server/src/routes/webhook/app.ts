import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
  LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type {
  ApplicationConfig,
  AuthRepository,
  SessionRepository,
  OpencodeService,
} from "@opencode-linear-agent/core";

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import {
  LinearEventProcessor,
  LinearService,
  IssueEventHandler,
  KvNotFoundError,
  Log,
} from "@opencode-linear-agent/core";
import { Result } from "better-result";
import { Hono } from "hono";
import { z } from "zod";

import { refreshAccessToken } from "../../token";

interface WebhookHandlerFactories {
  createProcessor?: (
    opencode: OpencodeService,
    linear: LinearService,
    sessions: SessionRepository,
    config: { organizationId: string; opencodeUrl?: string },
  ) => { process(event: AgentSessionEventWebhookPayload): Promise<void> };
}

const webhookTimestampSchema = z.object({
  webhookTimestamp: z.number(),
});

function isIssueWebhook(
  payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithIssueData {
  return payload.type === "Issue" && "issue" in payload && payload.issue !== undefined;
}

function isAgentSessionEventWebhook(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === "AgentSessionEvent" && "agentSession" in payload;
}

function isSupportedWebhook(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload | EntityWebhookPayloadWithIssueData {
  return isAgentSessionEventWebhook(payload) || isIssueWebhook(payload);
}

export function createWebhookApp(
  config: ApplicationConfig,
  authRepository: AuthRepository,
  sessionRepository: SessionRepository,
  opencode: OpencodeService,
  factories?: WebhookHandlerFactories,
) {
  const app = new Hono();
  const linearWebhookClient = new LinearWebhookClient(config.linearWebhookSecret);

  app.post("/api/webhook/linear", async (c) => {
    const log = Log.create({ service: "webhook" });

    const signature = c.req.header("linear-signature");
    if (!signature) {
      return c.text("Missing header linear-signature", 400);
    }

    const arrayBuffer = await c.req.arrayBuffer();
    const requestBuffer = Buffer.from(arrayBuffer);
    const parsed = Result.try(() =>
      webhookTimestampSchema.parse(JSON.parse(requestBuffer.toString())),
    );
    if (Result.isError(parsed)) {
      return c.text("Invalid or missing webhookTimestamp in payload", 400);
    }

    const webhookPayloadResult = Result.try(() =>
      linearWebhookClient.parseData(requestBuffer, signature, parsed.value.webhookTimestamp),
    );
    if (Result.isError(webhookPayloadResult)) {
      return c.json(
        {
          error: "Invalid webhook signature or payload",
        },
        400,
      );
    }
    const webhookPayload = webhookPayloadResult.value;

    if (
      config.linearOrganizationId &&
      webhookPayload.organizationId !== config.linearOrganizationId
    ) {
      return c.json(
        {
          error: "Webhook organization ID does not match configured organization ID",
        },
        400,
      );
    }

    if (!isSupportedWebhook(webhookPayload)) {
      return c.text("", 200);
    }

    const accessTokenResult = await authRepository.getAccessToken(webhookPayload.organizationId);
    let accessToken: string;
    if (accessTokenResult.isErr()) {
      if (!KvNotFoundError.is(accessTokenResult.error)) {
        return c.json({ error: accessTokenResult.error.message }, 500);
      }

      const oauthConfig = {
        clientId: config.linearClientId,
        clientSecret: config.linearClientSecret,
      };
      const refreshed = await refreshAccessToken(
        authRepository,
        oauthConfig,
        webhookPayload.organizationId,
      );
      if (refreshed.isErr()) {
        return c.json({ error: refreshed.error.message }, 500);
      }

      accessToken = refreshed.value;
    } else {
      accessToken = accessTokenResult.value;
    }

    const linearService = new LinearService(accessToken);

    if (isAgentSessionEventWebhook(webhookPayload)) {
      const processorConfig = {
        organizationId: webhookPayload.organizationId,
        opencodeUrl: config.opencodeServerUrl,
      };
      const handler =
        factories?.createProcessor?.(opencode, linearService, sessionRepository, processorConfig) ??
        new LinearEventProcessor(opencode, linearService, sessionRepository, processorConfig);
      handler.process(webhookPayload).catch((error: unknown) => {
        log.error("Agent session dispatch failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (isIssueWebhook(webhookPayload)) {
      const issueHandler = new IssueEventHandler(linearService, opencode, sessionRepository);
      issueHandler.process(webhookPayload).catch((error: unknown) => {
        log.error("Issue event processing failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return c.json({ success: true });
  });

  return app;
}
