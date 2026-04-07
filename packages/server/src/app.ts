import type {
  ApplicationConfig,
  OAuthStateRepository,
  AuthRepository,
  SessionRepository,
  OpencodeService,
} from "@opencode-linear-agent/core";
import type { GetConnInfo } from "hono/conninfo";

import { Hono } from "hono";
import { logger } from "hono/logger";

import { createOAuthApp } from "./routes/oauth/app";
import { createWebhookApp } from "./routes/webhook/app";

export function createApp(
  config: ApplicationConfig,
  oauthStateRepository: OAuthStateRepository,
  authRepository: AuthRepository,
  sessionRepository: SessionRepository,
  opencode: OpencodeService,
  getConnInfo: GetConnInfo,
) {
  const app = new Hono();

  const oauth = createOAuthApp(config, oauthStateRepository, authRepository);
  const webhook = createWebhookApp(
    config,
    authRepository,
    sessionRepository,
    opencode,
    getConnInfo,
  );

  app.use(logger());

  app.route("/", oauth);
  app.route("/", webhook);

  return app;
}
