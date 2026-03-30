import { Hono } from "hono";
import { ipRestriction } from "hono/ip-restriction";
import {
  type ApplicationConfig,
  type AuthRepository,
  type SessionRepository,
  type OpencodeService,
  LinearService,
  WorktreeManager,
  IssueEventHandler,
  Log,
} from "@opencode-linear-agent/core";
import {
  LinearWebhookClient,
  type AgentSessionEventWebhookPayload,
  type EntityWebhookPayloadWithIssueData,
  type LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import { Result } from "better-result";
import { z } from "zod";
import { dispatchAgentSessionEvent } from "../../AgentSessionDispatcher";
import { refreshAccessToken } from "../../token";
import type { GetConnInfo } from "hono/conninfo";

const webhookTimestampSchema = z.object({
  webhookTimestamp: z.number(),
});

function isIssueWebhook(
  payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithIssueData {
  return (
    payload.type === "Issue" &&
    "issue" in payload &&
    payload.issue !== undefined
  );
}

function isAgentSessionEventWebhook(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === "AgentSessionEvent" && "agentSession" in payload;
}

function isSupportedWebhook(
  payload: LinearWebhookPayload,
): payload is
  | AgentSessionEventWebhookPayload
  | EntityWebhookPayloadWithIssueData {
  return isAgentSessionEventWebhook(payload) || isIssueWebhook(payload);
}

export function createWebhookApp(
  config: ApplicationConfig,
  authRepository: AuthRepository,
  sessionRepository: SessionRepository,
  opencode: OpencodeService,
  getConnInfo: GetConnInfo,
) {
  const app = new Hono();
  const linearWebhookClient = new LinearWebhookClient(
    config.linearWebhookSecret,
  );

  app.use(
    "/api/webhook/linear",
    ipRestriction(getConnInfo, {
      denyList: [],
      // Source: https://linear.app/developers/webhooks#securing-webhooks
      allowList: [
        "35.231.147.226",
        "35.243.134.228",
        "34.140.253.14",
        "34.38.87.206",
        "34.134.222.122",
        "35.222.25.142",
      ],
    }),
  );

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
      linearWebhookClient.parseData(
        requestBuffer,
        signature,
        parsed.value.webhookTimestamp,
      ),
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
          error:
            "Webhook organization ID does not match configured organization ID",
        },
        400,
      );
    }

    if (!isSupportedWebhook(webhookPayload)) {
      return c.text("", 200);
    }

    let accessToken = await authRepository.getAccessToken(
      webhookPayload.organizationId,
    );
    if (!accessToken) {
      const oauthConfig = {
        clientId: config.linearClientId,
        clientSecret: config.linearClientSecret,
      };
      accessToken = await refreshAccessToken(
        authRepository,
        oauthConfig,
        webhookPayload.organizationId,
      );
    }
    const linearService = new LinearService(accessToken);

    if (isAgentSessionEventWebhook(webhookPayload)) {
      dispatchAgentSessionEvent(
        webhookPayload,
        linearService,
        opencode,
        sessionRepository,
        {
          organizationId: webhookPayload.organizationId,
          projectsPath: config.projectsPath,
        },
      ).catch((error: unknown) => {
        log.error("Agent session dispatch failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (isIssueWebhook(webhookPayload)) {
      const worktreeManager = new WorktreeManager(
        opencode,
        linearService,
        sessionRepository,
        config.projectsPath,
      );
      const issueHandler = new IssueEventHandler(
        linearService,
        opencode,
        sessionRepository,
        worktreeManager,
      );
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
