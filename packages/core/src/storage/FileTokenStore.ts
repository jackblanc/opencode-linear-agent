import { Result } from "better-result";

import { getStateRootPath } from "../utils/paths";
import { createFileAgentState } from "../state/root";
import type { AuthRecord, RefreshTokenData, TokenStore } from "./types";

function isAccessTokenValid(
  record: { accessToken: string; accessTokenExpiresAt: number },
  now: number,
): boolean {
  return record.accessToken.length > 0 && record.accessTokenExpiresAt > now;
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly statePath = getStateRootPath()) {}

  private getStore() {
    return createFileAgentState(this.statePath).auth;
  }

  async getAccessToken(organizationId: string): Promise<string | null> {
    const store = this.getStore();
    const hasRecord = await store.has(organizationId);
    if (Result.isError(hasRecord)) {
      throw new Error(hasRecord.error.message);
    }
    if (!hasRecord.value) {
      return null;
    }

    const record = await store.get(organizationId);
    if (Result.isError(record)) {
      throw new Error(record.error.message);
    }
    if (!isAccessTokenValid(record.value, Date.now())) {
      return null;
    }
    return record.value.accessToken;
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<RefreshTokenData | null> {
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

  async getAuthRecord(organizationId: string): Promise<AuthRecord | null> {
    const store = this.getStore();
    const hasRecord = await store.has(organizationId);
    if (Result.isError(hasRecord)) {
      throw new Error(hasRecord.error.message);
    }
    if (!hasRecord.value) {
      return null;
    }

    const result = await store.get(organizationId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  async putAuthRecord(record: AuthRecord): Promise<void> {
    const result = await this.getStore().put(record.organizationId, record);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }
}
