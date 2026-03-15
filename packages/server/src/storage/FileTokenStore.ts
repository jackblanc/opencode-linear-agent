/**
 * File-based implementation of TokenStore
 *
 * Persists durable OAuth state in auth.json.
 */

import { mkdir, readFile, writeFile, exists } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  TokenStore,
  RefreshTokenData,
  AuthData,
} from "@opencode-linear-agent/core";
import { getAuthPath, parseAuthData } from "@opencode-linear-agent/core";

function createEmptyAuthData(): AuthData {
  return {
    version: 1,
    organizations: {},
  };
}

/**
 * File-based TokenStore implementation
 */
export class FileTokenStore implements TokenStore {
  private data: AuthData = createEmptyAuthData();
  private loaded = false;

  constructor(private readonly filePath = getAuthPath()) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.reload();
  }

  private async reload(): Promise<void> {
    if (!(await exists(this.filePath))) {
      this.data = createEmptyAuthData();
      this.loaded = true;
      return;
    }

    const file = await readFile(this.filePath, "utf-8");
    const json: unknown = JSON.parse(file);
    this.data = parseAuthData(json);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }

  private async getOrg(
    organizationId: string,
  ): Promise<AuthData["organizations"][string]> {
    await this.ensureLoaded();
    return this.data.organizations[organizationId] ?? {};
  }

  async getAccessToken(organizationId: string): Promise<string | null> {
    await this.reload();
    const org = this.data.organizations[organizationId];
    const accessToken = org?.accessToken;
    if (!accessToken) {
      return null;
    }
    if (Date.now() > accessToken.expiresAt) {
      if (org) {
        delete org.accessToken;
        await this.save();
      }
      return null;
    }
    return accessToken.value;
  }

  async setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void> {
    const org = await this.getOrg(organizationId);
    org.accessToken = {
      value: token,
      expiresAt:
        expirationTtl === undefined
          ? Number.MAX_SAFE_INTEGER
          : Date.now() + expirationTtl * 1000,
    };
    this.data.organizations[organizationId] = org;
    await this.save();
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<RefreshTokenData | null> {
    await this.reload();
    return this.data.organizations[organizationId]?.refreshToken ?? null;
  }

  async setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void> {
    const org = await this.getOrg(organizationId);
    org.refreshToken = data;
    this.data.organizations[organizationId] = org;
    await this.save();
  }
}
