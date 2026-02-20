import { Result } from "better-result";
import type { LinearWebhookPayload } from "@linear/sdk/webhooks";
import { Log } from "./logger";
import type { OpencodeService } from "./opencode/OpencodeService";
import type { SessionRepository } from "./session/SessionRepository";
import type { WorktreeManager } from "./session/WorktreeManager";

interface CleanupIssueEvent {
  issueId: string;
  issueIdentifier: string;
  issueStateType: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Handles issue webhooks that require session/worktree cleanup.
 */
export class IssueEventHandler {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly repository: SessionRepository,
    private readonly worktreeManager: WorktreeManager,
  ) {}

  async process(event: LinearWebhookPayload): Promise<void> {
    const cleanupEvent = this.toCleanupIssueEvent(event);
    if (!cleanupEvent) {
      return;
    }

    const log = Log.create({ service: "issue-cleanup" })
      .tag("issue", cleanupEvent.issueIdentifier)
      .tag("issueId", cleanupEvent.issueId)
      .tag("stateType", cleanupEvent.issueStateType);

    if (
      cleanupEvent.issueStateType !== "completed" &&
      cleanupEvent.issueStateType !== "canceled"
    ) {
      log.info("Issue state does not require cleanup");
      return;
    }

    const sessionIds = await this.repository.getIssueSessions(
      cleanupEvent.issueId,
    );
    if (sessionIds.length === 0) {
      log.info("No sessions found for issue cleanup");
      await this.repository.deleteIssueSessions(cleanupEvent.issueId);
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

      await this.worktreeManager.cleanupSessionResources(state, sessionLog);
      await this.repository.delete(linearSessionId);

      sessionLog.info("Session cleanup complete", {
        branchName: state.branchName,
        workdir: state.workdir,
      });
    }

    await this.repository.deleteIssueSessions(cleanupEvent.issueId);
    log.info("Issue cleanup complete");
  }

  private toCleanupIssueEvent(
    event: LinearWebhookPayload,
  ): CleanupIssueEvent | null {
    if (event.type !== "Issue") {
      return null;
    }

    const action = this.getString(event, "action");
    if (action !== "update") {
      return null;
    }

    const data = this.getRecord(event, "data");
    const issueId = this.getString(data, "id");
    const state = this.getRecord(data, "state");
    const issueStateType = this.getString(state, "type");

    if (!issueId || !issueStateType) {
      return null;
    }

    const issueIdentifier = this.getString(data, "identifier") ?? issueId;

    return {
      issueId,
      issueIdentifier,
      issueStateType,
    };
  }

  private getRecord(
    value: unknown,
    key: string,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const field = value[key];
    if (!isRecord(field)) {
      return undefined;
    }

    return field;
  }

  private getString(value: unknown, key: string): string | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const field = value[key];
    return typeof field === "string" ? field : undefined;
  }
}
