import { Result } from "better-result";
import { Log } from "../logger";
import type { LinearService } from "../linear-service/LinearService";
import type { SessionRepository } from "../session/SessionRepository";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { WorktreeManager } from "../session/WorktreeManager";

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
    private readonly opencode: Pick<OpencodeService, "abortSession">,
    private readonly repository: SessionRepository,
    private readonly worktreeManager: Pick<
      WorktreeManager,
      "cleanupSessionResources"
    >,
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

    const sessionIdsResult = await this.getIssueSessionIdsWithRetry(
      event.data.id,
      log,
    );
    if (Result.isError(sessionIdsResult)) {
      log.warn("Failed to load issue sessions from Linear", {
        error: sessionIdsResult.error.message,
        errorType: sessionIdsResult.error._tag,
      });
      return;
    }

    const sessionIds = sessionIdsResult.value;
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

      if (!state) {
        sessionLog.info("Session state already removed");
        continue;
      }

      const abortResult = await this.opencode.abortSession(
        state.opencodeSessionId,
        state.workdir,
      );
      const abortSucceeded = Result.isOk(abortResult);

      if (!abortSucceeded) {
        sessionLog.warn("Failed to abort OpenCode session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      const cleanupResult = await this.worktreeManager.cleanupSessionResources(
        state,
        sessionLog,
      );

      if (!cleanupResult.fullyCleaned) {
        sessionLog.warn(
          "Session cleanup incomplete; preserving session state",
          {
            branchName: state.branchName,
            workdir: state.workdir,
            worktreeRemoved: cleanupResult.worktreeRemoved,
            branchRemoved: cleanupResult.branchRemoved,
          },
        );
        continue;
      }

      if (!abortSucceeded) {
        sessionLog.warn(
          "OpenCode abort failed; preserving session state for retry",
          {
            branchName: state.branchName,
            workdir: state.workdir,
          },
        );
        continue;
      }

      await this.repository.delete(linearSessionId);

      sessionLog.info("Session cleanup complete", {
        branchName: state.branchName,
        workdir: state.workdir,
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
      if (Result.isOk(result)) {
        if (attempt > 1) {
          log.info("Issue session lookup recovered after retry", { attempt });
        }
        return result;
      }

      if (attempt >= ISSUE_SESSION_LOOKUP_MAX_ATTEMPTS) {
        return result;
      }

      log.warn("Issue session lookup failed, retrying", {
        attempt,
        maxAttempts: ISSUE_SESSION_LOOKUP_MAX_ATTEMPTS,
        error: result.error.message,
        errorType: result.error._tag,
      });

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
