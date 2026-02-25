import { Result } from "better-result";
import { Log } from "./logger";
import type { LinearService } from "./linear/LinearService";
import type { SessionRepository } from "./session/SessionRepository";
import type { OpencodeService } from "./opencode/OpencodeService";
import type { WorktreeManager } from "./session/WorktreeManager";

type CleanupIssueStateType = "completed" | "canceled";

export interface IssueCleanupWebhookPayload {
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

    const sessionIdsResult = await this.linear.getIssueAgentSessionIds(
      event.data.id,
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

      if (Result.isError(abortResult)) {
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
}
