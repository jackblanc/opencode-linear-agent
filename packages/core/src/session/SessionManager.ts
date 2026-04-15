import { Result } from "better-result";

import type { KvError } from "../kv/errors";
import type { OpencodeServiceError } from "../opencode-service/errors";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { SessionState } from "../state/schema";
import type { SessionRepository } from "../state/SessionRepository";
import type { Logger } from "../utils/logger";

import { KvNotFoundError } from "../kv/errors";
import { Log } from "../utils/logger";

type SessionManagerError = OpencodeServiceError | KvError;

/**
 * Result of getting or creating a session
 */
interface SessionResult {
  opencodeSessionId: string;
  existingState: SessionState | null;
  /** True if we created a new OpenCode session */
  isNewSession: boolean;
}

/**
 * Manages the lifecycle of OpenCode sessions linked to Linear sessions
 */
export class SessionManager {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly repository: SessionRepository,
  ) {}

  /**
   * Get or create an OpenCode session for a Linear session
   *
   * @returns Result containing the session ID, existing state, and whether this is a new session
   */
  async getOrCreateSession(
    linearSessionId: string,
    organizationId: string,
    issueId: string,
    projectId: string,
    branchName: string,
    workdir: string,
  ): Promise<Result<SessionResult, SessionManagerError>> {
    const log = Log.create({ service: "session" })
      .tag("issue", issueId)
      .tag("sessionId", linearSessionId);

    log.info("Looking up existing session state");

    const existingStateResult = await this.repository.get(linearSessionId);
    if (existingStateResult.isErr()) {
      if (!KvNotFoundError.is(existingStateResult.error)) {
        log.error("Failed to load existing session state", {
          error: existingStateResult.error.message,
          errorType: existingStateResult.error._tag,
        });
        return Result.err(existingStateResult.error);
      }

      return this.createNewSession(
        linearSessionId,
        organizationId,
        issueId,
        projectId,
        branchName,
        workdir,
        null,
        log,
      );
    }

    const existingState = existingStateResult.value;
    const sessionLog = log
      .tag("opencodeSession", existingState.opencodeSessionId.slice(0, 8))
      .tag("opencodeSessionId", existingState.opencodeSessionId);
    sessionLog.info("Found existing state, attempting to resume");

    const sessionResult = await this.opencode.getSession(existingState.opencodeSessionId, workdir);
    if (sessionResult.isErr()) {
      sessionLog.error("Failed to resume existing session", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });
      return Result.err(sessionResult.error);
    }

    sessionLog.info("Successfully resumed session");
    return Result.ok({
      opencodeSessionId: sessionResult.value.id,
      existingState,
      isNewSession: false,
    });
  }

  /**
   * Create a new OpenCode session
   */
  private async createNewSession(
    linearSessionId: string,
    organizationId: string,
    issueId: string,
    projectId: string,
    branchName: string,
    workdir: string,
    existingState: SessionState | null,
    log: Logger,
  ): Promise<Result<SessionResult, SessionManagerError>> {
    log.info("Creating new OpenCode session");

    return Result.gen(
      async function* (this: SessionManager) {
        const session = yield* Result.await(this.opencode.createSession(workdir));
        const sessionId = session.id;
        const sessionLog = log
          .tag("opencodeSession", sessionId.slice(0, 8))
          .tag("opencodeSessionId", sessionId);
        sessionLog.info("Created OpenCode session");

        const newState: SessionState = {
          opencodeSessionId: sessionId,
          linearSessionId,
          organizationId,
          issueId,
          projectId,
          branchName,
          workdir,
          lastActivityTime: Date.now(),
        };

        const saved = await this.repository.save(newState);
        if (saved.isErr()) {
          sessionLog.error("Failed to save session state", {
            error: saved.error.message,
            errorType: saved.error._tag,
          });
          return Result.err(saved.error);
        }

        sessionLog.info("Saved session state to repository", {
          branchName,
          workdir,
        });

        return Result.ok({
          opencodeSessionId: sessionId,
          existingState,
          isNewSession: true,
        });
      }.bind(this),
    );
  }

  /**
   * Update last activity time for a session
   */
  async touch(linearSessionId: string): Promise<Result<void, KvError>> {
    const state = await this.repository.get(linearSessionId);
    if (state.isErr()) {
      return KvNotFoundError.is(state.error) ? Result.ok(undefined) : Result.err(state.error);
    }

    state.value.lastActivityTime = Date.now();
    return this.repository.save(state.value);
  }

  /**
   * Clean up session state
   */
  async cleanup(linearSessionId: string): Promise<Result<void, KvError>> {
    return this.repository.delete(linearSessionId);
  }
}
