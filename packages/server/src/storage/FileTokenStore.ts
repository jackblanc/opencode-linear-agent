/**
 * File-based implementation of TokenStore
 *
 * Persists durable OAuth state in auth.json.
 */

import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
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

  constructor(private readonly filePath = getAuthPath()) {}

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.filePath}.lock`;
    const startedAt = Date.now();

    while (true) {
      const handle = await open(lockPath, "wx").then(
        (h) => h,
        async (e: unknown) => {
          if (
            e instanceof Error &&
            "code" in e &&
            e.code === "EEXIST" &&
            Date.now() - startedAt > 5000
          ) {
            await unlink(lockPath).catch(() => {});
            return null;
          }
          if (e instanceof Error && "code" in e && e.code === "EEXIST") {
            await Bun.sleep(50);
            return null;
          }
          throw e;
        },
      );

      if (!handle) {
        continue;
      }

      await handle.write(String(Date.now()));
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async reload(): Promise<void> {
    const bunFile = Bun.file(this.filePath);
    if (!(await bunFile.exists())) {
      this.data = createEmptyAuthData();
      return;
    }

    const text = await readFile(this.filePath, "utf-8");
    const json: unknown = JSON.parse(text);
    this.data = parseAuthData(json);
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }

  private async getOrg(
    organizationId: string,
  ): Promise<AuthData["organizations"][string]> {
    return this.data.organizations[organizationId] ?? {};
  }

  async getAccessToken(organizationId: string): Promise<string | null> {
    return this.withLock(async () => {
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
    });
  }

  async setAccessToken(
    organizationId: string,
    token: string,
    expirationTtl?: number,
  ): Promise<void> {
    await this.withLock(async () => {
      await this.reload();
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
    });
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<RefreshTokenData | null> {
    return this.withLock(async () => {
      await this.reload();
      return this.data.organizations[organizationId]?.refreshToken ?? null;
    });
  }

  async setRefreshTokenData(
    organizationId: string,
    data: RefreshTokenData,
  ): Promise<void> {
    await this.withLock(async () => {
      await this.reload();
      const org = await this.getOrg(organizationId);
      org.refreshToken = data;
      this.data.organizations[organizationId] = org;
      await this.save();
    });
  }
}
