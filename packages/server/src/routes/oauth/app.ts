import type {
  ApplicationConfig,
  OAuthStateRepository,
  AuthRepository,
} from "@opencode-linear-agent/core";

import { zValidator } from "@hono/zod-validator";
import { LinearClient } from "@linear/sdk";
import { KvNotFoundError } from "@opencode-linear-agent/core";
import { Hono } from "hono";
import { z } from "zod";

import { tokenExchangeResponseSchema } from "../../token";

export function createOAuthApp(
  config: ApplicationConfig,
  oauthStateRepository: OAuthStateRepository,
  authRepository: AuthRepository,
) {
  const callbackUrl = `https://${config.webhookServerPublicHostname}/api/oauth/callback`;
  const app = new Hono();

  app.get("/api/oauth/authorize", async (c) => {
    const state = crypto.randomUUID();
    const now = Date.now();
    const issued = await oauthStateRepository.issue(state, now, now + 5 * 60 * 1000);
    if (issued.isErr()) {
      return c.json({ message: issued.error.message }, 500);
    }

    const params = new URLSearchParams({
      client_id: config.linearClientId,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: ["write", "app:mentionable", "app:assignable"].join(","),
      state,
      actor: "app", // Authenticate as app, not user
    });
    const authUrl = `https://linear.app/oauth/authorize?${params.toString()}`;

    return c.redirect(authUrl, 302);
  });

  app.get(
    "/api/oauth/callback",
    zValidator(
      "query",
      z.object({
        code: z.string(),
        state: z.string(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const validState = await oauthStateRepository.consume(query.state, Date.now());
      if (validState.isErr()) {
        return KvNotFoundError.is(validState.error)
          ? c.json(
              {
                message: "Invalid or expired state parameter",
              },
              400,
            )
          : c.json({ message: validState.error.message }, 500);
      }

      const response = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.linearClientId,
          client_secret: config.linearClientSecret,
          redirect_uri: callbackUrl,
          code: query.code,
        }),
      });
      if (!response.ok) {
        return c.json({ message: "Failed to exchange code for token" }, 502);
      }
      const tokenResult = tokenExchangeResponseSchema.safeParse(await response.json());
      if (!tokenResult.success) {
        return c.json({ message: "Invalid token response from Linear" }, 502);
      }
      const client = new LinearClient({
        accessToken: tokenResult.data.access_token,
      });
      const viewer = await client.viewer;
      const organization = await viewer.organization;

      const saved = await authRepository.putAuthRecord({
        organizationId: organization.id,
        accessToken: tokenResult.data.access_token,
        accessTokenExpiresAt: tokenResult.data.expires_in * 1000 + Date.now(),
        refreshToken: tokenResult.data.refresh_token,
        appId: viewer.id,
        installedAt: new Date().toISOString(),
        workspaceName: organization.name,
      });
      if (saved.isErr()) {
        return c.json({ message: saved.error.message }, 500);
      }

      return c.json({
        message: "Successfully authorized OpenCode Agent for organization " + organization.name,
      });
    },
  );

  return app;
}
