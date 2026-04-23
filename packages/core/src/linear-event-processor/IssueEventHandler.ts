import type { LinearService } from "../linear-service/LinearService";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { AgentStateNamespace } from "../state/root";

import { KvNotFoundError } from "../kv/errors";
import { deleteSessionState } from "../state/session-state";
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
    private readonly opencode: Pick<OpencodeService, "abortSession" | "removeWorkspace">,
    private readonly agentState: AgentStateNamespace,
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

    const workspace = await this.agentState.issueWorkspace.get(event.data.id);
    if (workspace.isErr() && !KvNotFoundError.is(workspace.error)) {
      log.warn("Failed to load issue workspace state for cleanup", {
        error: workspace.error.message,
        errorType: workspace.error._tag,
      });
      throw workspace.error;
    }

    const sessionIdsResult = await this.getIssueSessionIdsWithRetry(event.data.id, log);
    if (sessionIdsResult.isErr()) {
      log.warn("Failed to load issue sessions from Linear", {
        error: sessionIdsResult.error.message,
        errorType: sessionIdsResult.error._tag,
      });
      throw sessionIdsResult.error;
    }
    const sessionIds = sessionIdsResult.value;

    if (sessionIds.length === 0 && workspace.isErr()) {
      log.info("No sessions or workspace found for issue cleanup");
      return;
    }

    log.info("Starting cleanup for issue sessions", {
      sessionCount: sessionIds.length,
    });

    let canRemoveWorkspace = true;

    for (const linearSessionId of sessionIds) {
      const sessionLog = log.tag("sessionId", linearSessionId);
      const state = await this.agentState.session.get(linearSessionId);
      if (state.isErr()) {
        if (!KvNotFoundError.is(state.error)) {
          sessionLog.warn("Failed to load session state for cleanup", {
            error: state.error.message,
            errorType: state.error._tag,
          });
          throw state.error;
        }

        sessionLog.info("Session state already removed");
        continue;
      }
      const session = state.value;

      const abortResult = await this.opencode.abortSession(
        session.opencodeSessionId,
        session.workdir,
      );
      const abortSucceeded = abortResult.isOk();
      if (abortResult.isErr()) {
        sessionLog.warn("Failed to abort OpenCode session", {
          error: abortResult.error.message,
          errorType: abortResult.error._tag,
        });
      }

      if (!abortSucceeded) {
        canRemoveWorkspace = false;
        sessionLog.warn("OpenCode abort failed; preserving session state for retry", {
          branchName: session.branchName,
          workdir: session.workdir,
        });
        continue;
      }

      const removed = await deleteSessionState(this.agentState, linearSessionId);
      if (removed.isErr()) {
        sessionLog.warn("Failed to delete session state after cleanup", {
          error: removed.error.message,
          errorType: removed.error._tag,
        });
        throw removed.error;
      }

      sessionLog.info("Session cleanup complete", {
        branchName: session.branchName,
        workdir: session.workdir,
      });
    }

    if (!canRemoveWorkspace || workspace.isErr()) {
      log.info("Skipping workspace cleanup", {
        hasWorkspace: workspace.isOk(),
        canRemoveWorkspace,
      });
      return;
    }

    const removeResult = await this.opencode.removeWorkspace(workspace.value.workspaceId);
    if (removeResult.isErr()) {
      log.warn("Failed to remove OpenCode workspace", {
        workspaceId: workspace.value.workspaceId,
        error: removeResult.error.message,
        errorType: removeResult.error._tag,
      });
      return;
    }

    const cleared = await this.agentState.issueWorkspace.delete(event.data.id);
    if (cleared.isErr()) {
      log.warn("Failed to delete issue workspace state after cleanup", {
        workspaceId: workspace.value.workspaceId,
        error: cleared.error.message,
        errorType: cleared.error._tag,
      });
      throw cleared.error;
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
      if (result.isOk()) {
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
