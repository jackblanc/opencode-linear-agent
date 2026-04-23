import type {
  ApplicationConfig,
  AgentStateNamespace,
  OAuthStateRepository,
  AuthRepository,
  OpencodeService,
} from "@opencode-linear-agent/core";

import { Hono } from "hono";
import { logger } from "hono/logger";

import { createOAuthApp } from "./routes/oauth/app";
import { createWebhookApp } from "./routes/webhook/app";

export function createApp(
  config: ApplicationConfig,
  agentState: AgentStateNamespace,
  oauthStateRepository: OAuthStateRepository,
  authRepository: AuthRepository,
  opencode: OpencodeService,
) {
  const app = new Hono();

  const oauth = createOAuthApp(config, oauthStateRepository, authRepository);
  const webhook = createWebhookApp(config, authRepository, agentState, opencode);

  app.use(logger());

  app.route("/", oauth);
  app.route("/", webhook);

  return app;
}
