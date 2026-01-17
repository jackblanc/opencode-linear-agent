/**
 * Linear API client wrapper with Result-based error handling.
 */

import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import { Result } from "better-result";
import type {
  ActivityContent,
  PlanItem,
  SignalMetadata,
  ElicitationSignal,
} from "./types";
import { LinearApiError, type LinearServiceError } from "./errors";

/**
 * Maps elicitation signals to Linear's AgentActivitySignal
 */
function mapSignal(signal: ElicitationSignal): AgentActivitySignal {
  return signal === "auth"
    ? AgentActivitySignal.Auth
    : AgentActivitySignal.Select;
}

/**
 * Linear service interface for agent activities
 */
export interface LinearService {
  createSession(issueId: string): Promise<Result<string, LinearServiceError>>;
  getIssueId(identifier: string): Promise<Result<string, LinearServiceError>>;
  postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral?: boolean,
  ): Promise<Result<void, LinearServiceError>>;
  postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, LinearServiceError>>;
  updatePlan(
    sessionId: string,
    plan: PlanItem[],
  ): Promise<Result<void, LinearServiceError>>;
  setExternalLink(
    sessionId: string,
    url: string,
  ): Promise<Result<void, LinearServiceError>>;
}

/**
 * Create a Linear service from an access token.
 */
export function createLinearService(accessToken: string): LinearService {
  const client = new LinearClient({ accessToken });
  return new LinearServiceImpl(client);
}

/**
 * Implementation of LinearService using @linear/sdk
 */
class LinearServiceImpl implements LinearService {
  constructor(private client: LinearClient) {}

  async createSession(
    issueId: string,
  ): Promise<Result<string, LinearServiceError>> {
    return Result.tryPromise({
      try: async () => {
        const payload = await this.client.agentSessionCreateOnIssue({
          issueId,
        });
        const session = await payload.agentSession;
        if (!session) {
          throw new Error(
            "Failed to create agent session - no session returned",
          );
        }
        return session.id;
      },
      catch: (e) =>
        new LinearApiError({ operation: "createSession", cause: e }),
    });
  }

  async getIssueId(
    identifier: string,
  ): Promise<Result<string, LinearServiceError>> {
    return Result.tryPromise({
      try: async () => {
        const issue = await this.client.issue(identifier);
        return issue.id;
      },
      catch: (e) => new LinearApiError({ operation: "getIssueId", cause: e }),
    });
  }

  async postActivity(
    sessionId: string,
    content: ActivityContent,
    ephemeral = false,
  ): Promise<Result<void, LinearServiceError>> {
    return Result.tryPromise({
      try: async () => {
        await this.client.createAgentActivity({
          agentSessionId: sessionId,
          content,
          ephemeral,
        });
      },
      catch: (e) => new LinearApiError({ operation: "postActivity", cause: e }),
    });
  }

  async postElicitation(
    sessionId: string,
    body: string,
    signal: ElicitationSignal,
    metadata?: SignalMetadata,
  ): Promise<Result<void, LinearServiceError>> {
    return Result.tryPromise({
      try: async () => {
        await this.client.createAgentActivity({
          agentSessionId: sessionId,
          content: { type: "elicitation", body },
          signal: mapSignal(signal),
          signalMetadata: metadata,
          ephemeral: false,
        });
      },
      catch: (e) =>
        new LinearApiError({ operation: "postElicitation", cause: e }),
    });
  }

  async updatePlan(
    sessionId: string,
    plan: PlanItem[],
  ): Promise<Result<void, LinearServiceError>> {
    return Result.tryPromise({
      try: async () => {
        const session = await this.client.agentSession(sessionId);
        await session.update({ plan });
      },
      catch: (e) => new LinearApiError({ operation: "updatePlan", cause: e }),
    });
  }

  async setExternalLink(
    sessionId: string,
    url: string,
  ): Promise<Result<void, LinearServiceError>> {
    return Result.tryPromise({
      try: async () => {
        const session = await this.client.agentSession(sessionId);
        await session.update({ externalLink: url });
      },
      catch: (e) =>
        new LinearApiError({ operation: "setExternalLink", cause: e }),
    });
  }
}
