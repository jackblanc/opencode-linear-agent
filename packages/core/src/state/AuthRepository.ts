import type { Result as ResultType } from "better-result";

import { Result, TaggedError } from "better-result";

import type { KvError } from "../kv/errors";
import type { AgentStateNamespace } from "./root";
import type { AuthRecord } from "./schema";

export class AuthTokenFileError extends TaggedError("AuthTokenFileError")<{
  message: string;
  reason: string;
}>() {
  constructor(args: { reason: string }) {
    super({
      reason: args.reason,
      message: `Failed to write OAuth access token file: ${args.reason}`,
    });
  }
}

export class AuthAccessTokenExpiredError extends TaggedError("AuthAccessTokenExpiredError")<{
  message: string;
  organizationId: string;
  expiresAt: number;
}>() {
  constructor(args: { organizationId: string; expiresAt: number }) {
    super({
      organizationId: args.organizationId,
      expiresAt: args.expiresAt,
      message: `OAuth access token expired for organization ${args.organizationId}`,
    });
  }
}

export type AuthRepositoryError = KvError | AuthTokenFileError | AuthAccessTokenExpiredError;

type RefreshTokenData = {
  refreshToken: string;
  appId: string;
  organizationId: string;
  installedAt: string;
  workspaceName?: string;
};

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

  async getAccessToken(organizationId: string): Promise<ResultType<string, AuthRepositoryError>> {
    return Result.gen(
      async function* (this: AuthRepository) {
        const record = yield* Result.await(this.agentState.auth.get(organizationId));
        if (!isAccessTokenValid(record, Date.now())) {
          return Result.err(
            new AuthAccessTokenExpiredError({
              organizationId,
              expiresAt: record.accessTokenExpiresAt,
            }),
          );
        }

        return Result.ok(record.accessToken);
      }.bind(this),
    );
  }

  async getRefreshTokenData(
    organizationId: string,
  ): Promise<ResultType<RefreshTokenData, AuthRepositoryError>> {
    return Result.gen(
      async function* (this: AuthRepository) {
        const record = yield* Result.await(this.getAuthRecord(organizationId));
        return Result.ok({
          refreshToken: record.refreshToken,
          appId: record.appId,
          organizationId: record.organizationId,
          installedAt: record.installedAt,
          workspaceName: record.workspaceName,
        });
      }.bind(this),
    );
  }

  async getAuthRecord(
    organizationId: string,
  ): Promise<ResultType<AuthRecord, AuthRepositoryError>> {
    return this.agentState.auth.get(organizationId);
  }

  async putAuthRecord(record: AuthRecord): Promise<ResultType<void, AuthRepositoryError>> {
    return Result.gen(
      async function* (this: AuthRepository) {
        yield* Result.await(this.agentState.auth.put(record.organizationId, record));

        const writeTokenToFile = this.writeTokenToFile;
        if (writeTokenToFile) {
          yield* Result.await(
            Result.tryPromise({
              try: async () => writeTokenToFile(record.accessToken),
              catch: (cause: unknown) =>
                new AuthTokenFileError({
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
          );
        }

        return Result.ok(undefined);
      }.bind(this),
    );
  }
}
