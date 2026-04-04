import { Result } from "better-result";

import { type AgentStateNamespace } from "./root";
import type { AuthRecord } from "./schema";

function isAccessTokenValid(
  record: { accessToken: string; accessTokenExpiresAt: number },
  now: number,
): boolean {
  return record.accessToken.length > 0 && record.accessTokenExpiresAt > now;
}

export class AuthRepository {
  constructor(
    private readonly agentState: AgentStateNamespace,
    private readonly writeTokenToFile?: (token: string) => Promise<void>,
  ) {}

  async getAccessToken(organizationId: string): Promise<string | null> {
    const hasRecord = await this.agentState.auth.has(organizationId);
    if (Result.isError(hasRecord)) {
      throw new Error(hasRecord.error.message);
    }
    if (!hasRecord.value) {
      return null;
    }

    const record = await this.agentState.auth.get(organizationId);
    if (Result.isError(record)) {
      throw new Error(record.error.message);
    }
    if (!isAccessTokenValid(record.value, Date.now())) {
      return null;
    }
    return record.value.accessToken;
  }

  async getRefreshTokenData(organizationId: string) {
    const record = await this.getAuthRecord(organizationId);
    if (!record) {
      return null;
    }
    return {
      refreshToken: record.refreshToken,
      appId: record.appId,
      organizationId: record.organizationId,
      installedAt: record.installedAt,
      workspaceName: record.workspaceName,
    };
  }

  async getAuthRecord(organizationId: string) {
    const hasRecord = await this.agentState.auth.has(organizationId);
    if (Result.isError(hasRecord)) {
      throw new Error(hasRecord.error.message);
    }
    if (!hasRecord.value) {
      return null;
    }

    const result = await this.agentState.auth.get(organizationId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  async putAuthRecord(record: AuthRecord) {
    const result = await this.agentState.auth.put(
      record.organizationId,
      record,
    );
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    if (this.writeTokenToFile) {
      await this.writeTokenToFile(record.accessToken);
    }
  }
}
