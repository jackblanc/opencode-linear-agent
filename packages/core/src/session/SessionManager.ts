import { Result } from "better-result";

import type { OpencodeServiceError } from "../opencode-service/errors";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { SessionState } from "../state/schema";
import type { SessionRepository } from "../state/SessionRepository";
import type { Logger } from "../utils/logger";

import { Log } from "../utils/logger";

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
  ): Promise<Result<SessionResult, OpencodeServiceError>> {
    const log = Log.create({ service: "session" })
      .tag("issue", issueId)
      .tag("sessionId", linearSessionId);

    log.info("Looking up existing session state");

    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.opencodeSessionId) {
      const sessionLog = log
        .tag("opencodeSession", existingState.opencodeSessionId.slice(0, 8))
        .tag("opencodeSessionId", existingState.opencodeSessionId);
      sessionLog.info("Found existing state, attempting to resume");

      const sessionResult = await this.opencode.getSession(
        existingState.opencodeSessionId,
        workdir,
      );

      if (Result.isOk(sessionResult)) {
        sessionLog.info("Successfully resumed session");
        return Result.ok({
          opencodeSessionId: sessionResult.value.id,
          existingState,
          isNewSession: false,
        });
      }

      sessionLog.error("Failed to resume existing session", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });

      return Result.err(sessionResult.error);
    }

    // No existing state - create fresh session
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
  ): Promise<Result<SessionResult, OpencodeServiceError>> {
    log.info("Creating new OpenCode session");

    // Don't pass a title - OpenCode auto-generates titles based on the first prompt
    const sessionResult = await this.opencode.createSession(workdir);

    if (Result.isError(sessionResult)) {
      log.error("Failed to create OpenCode session", {
        error: sessionResult.error.message,
        errorType: sessionResult.error._tag,
      });
      return Result.err(sessionResult.error);
    }

    const sessionId = sessionResult.value.id;

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

    await this.repository.save(newState);

    sessionLog.info("Saved session state to repository", {
      branchName,
      workdir,
    });

    return Result.ok({
      opencodeSessionId: sessionId,
      existingState,
      isNewSession: true,
    });
  }

  /**
   * Update last activity time for a session
   */
  async touch(linearSessionId: string): Promise<void> {
    const state = await this.repository.get(linearSessionId);
    if (state) {
      state.lastActivityTime = Date.now();
      await this.repository.save(state);
    }
  }

  /**
   * Clean up session state
   */
  async cleanup(linearSessionId: string): Promise<void> {
    await this.repository.delete(linearSessionId);
  }
}
