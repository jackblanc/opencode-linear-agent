import type { LinearService } from "../linear-service/LinearService";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { SessionRepository } from "../state/SessionRepository";

import { KvNotFoundError } from "../kv/errors";
import { Log } from "../utils/logger";

type CleanupIssueStateType = "completed" | "canceled";
const ISSUE_SESSION_LOOKUP_MAX_ATTEMPTS = 3;
const ISSUE_SESSION_LOOKUP_DELAY_MS = 1000;

interface IssueCleanupWebhookPayload {
  type: "Issue";
  action: string;
  data: {
    id: string;
    identifier: string;
    state: {
      type: string;
    };
  };
}

/**
 * Handles issue webhooks that require session/worktree cleanup.
 */
export class IssueEventHandler {
  constructor(
    private readonly linear: LinearService,
    private readonly opencode: Pick<OpencodeService, "abortSession" | "removeWorktree">,
    private readonly repository: SessionRepository,
  ) {}

  async process(event: IssueCleanupWebhookPayload): Promise<void> {
    if (event.action !== "update") {
      return;
    }

    const issueStateType = this.toCleanupIssueStateType(event.data.state.type);
    if (!issueStateType) {
      return;
    }

    const log = Log.create({ service: "issue-cleanup" })
      .tag("issue", event.data.identifier)
      .tag("issueId", event.data.id)
      .tag("stateType", issueStateType);

    const sessionIdsResult = await this.getIssueSessionIdsWithRetry(event.data.id, log);
    const sessionIds = sessionIdsResult.match({
      ok: (value) => value,
      err: (error) => {
        log.warn("Failed to load issue sessions from Linear", {
          error: error.message,
          errorType: error._tag,
        });
        return null;
      },
    });
    if (!sessionIds) {
      return;
    }

    if (sessionIds.length === 0) {
      log.info("No sessions found for issue cleanup");
      return;
    }

    log.info("Starting cleanup for issue sessions", {
      sessionCount: sessionIds.length,
    });

    for (const linearSessionId of sessionIds) {
      const sessionLog = log.tag("sessionId", linearSessionId);
      const state = await this.repository.get(linearSessionId);
      const session = state.match({
        ok: (value) => value,
        err: (error) => {
          if (!KvNotFoundError.is(error)) {
            sessionLog.warn("Failed to load session state for cleanup", {
              error: error.message,
              errorType: error._tag,
            });
            return null;
          }

          sessionLog.info("Session state already removed");
          return null;
        },
      });
      if (!session) {
        continue;
      }

      const abortResult = await this.opencode.abortSession(
        session.opencodeSessionId,
        session.workdir,
      );
      const abortSucceeded = abortResult.match({
        ok: () => true,
        err: (error) => {
          sessionLog.warn("Failed to abort OpenCode session", {
            error: error.message,
            errorType: error._tag,
          });
          return false;
        },
      });

      const removeResult = await this.opencode.removeWorktree(session.workdir);
      const worktreeRemoved = removeResult.match({
        ok: () => true,
        err: (error) => {
          sessionLog.warn("Failed to remove OpenCode worktree", {
            branchName: session.branchName,
            workdir: session.workdir,
            error: error.message,
            errorType: error._tag,
          });
          return false;
        },
      });
      if (!worktreeRemoved) {
        continue;
      }

      if (!abortSucceeded) {
        sessionLog.warn("OpenCode abort failed; preserving session state for retry", {
          branchName: session.branchName,
          workdir: session.workdir,
        });
        continue;
      }

      const removed = await this.repository.delete(linearSessionId);
      const stateDeleted = removed.match({
        ok: () => true,
        err: (error) => {
          sessionLog.warn("Failed to delete session state after cleanup", {
            error: error.message,
            errorType: error._tag,
          });
          return false;
        },
      });
      if (!stateDeleted) {
        continue;
      }

      sessionLog.info("Session cleanup complete", {
        branchName: session.branchName,
        workdir: session.workdir,
      });
    }

    log.info("Issue cleanup complete");
  }

  private toCleanupIssueStateType(value: string): CleanupIssueStateType | null {
    switch (value) {
      case "completed":
      case "canceled":
        return value;
      default:
        return null;
    }
  }

  private async getIssueSessionIdsWithRetry(
    issueId: string,
    log: ReturnType<typeof Log.create>,
  ): Promise<ReturnType<LinearService["getIssueAgentSessionIds"]>> {
    let attempt = 1;

    for (;;) {
      const result = await this.linear.getIssueAgentSessionIds(issueId);
      const retry = result.match({
        ok: () => {
          if (attempt > 1) {
            log.info("Issue session lookup recovered after retry", { attempt });
          }
          return false;
        },
        err: (error) => {
          if (attempt >= ISSUE_SESSION_LOOKUP_MAX_ATTEMPTS) {
            return false;
          }

          log.warn("Issue session lookup failed, retrying", {
            attempt,
            maxAttempts: ISSUE_SESSION_LOOKUP_MAX_ATTEMPTS,
            error: error.message,
            errorType: error._tag,
          });
          return true;
        },
      });
      if (!retry) {
        return result;
      }

      attempt += 1;
      await this.wait(ISSUE_SESSION_LOOKUP_DELAY_MS);
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
