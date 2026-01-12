/**
 * File-based implementation of SessionRepository
 *
 * Wraps FileStore for session-specific operations.
 */

import type { KeyValueStore } from "@linear-opencode-agent/core";
import type {
  SessionRepository,
  SessionState,
  WorktreeInfo,
  PendingQuestion,
  PendingPermission,
} from "@linear-opencode-agent/core";

/**
 * Key prefix for session storage
 */
const SESSION_PREFIX = "session:";

/**
 * Key prefix for worktree storage (indexed by issue ID)
 */
const WORKTREE_PREFIX = "worktree:";

/**
 * Key prefix for pending question storage
 */
const QUESTION_PREFIX = "question:";

/**
 * Key prefix for pending permission storage
 */
const PERMISSION_PREFIX = "permission:";

/**
 * File-based SessionRepository implementation
 */
export class FileSessionRepository implements SessionRepository {
  constructor(private readonly kv: KeyValueStore) {}

  async get(linearSessionId: string): Promise<SessionState | null> {
    return this.kv.get<SessionState>(`${SESSION_PREFIX}${linearSessionId}`);
  }

  async save(state: SessionState): Promise<void> {
    await this.kv.put(`${SESSION_PREFIX}${state.linearSessionId}`, state);

    // Also save worktree info indexed by issue for cross-session reuse
    const worktreeInfo: WorktreeInfo = {
      workdir: state.workdir,
      branchName: state.branchName,
    };
    await this.kv.put(`${WORKTREE_PREFIX}${state.issueId}`, worktreeInfo);
  }

  async delete(linearSessionId: string): Promise<void> {
    await this.kv.delete(`${SESSION_PREFIX}${linearSessionId}`);
    // Note: We don't delete worktree info as other sessions may still use it
  }

  async findWorktreeByIssue(issueId: string): Promise<WorktreeInfo | null> {
    return this.kv.get<WorktreeInfo>(`${WORKTREE_PREFIX}${issueId}`);
  }

  async getPendingQuestion(
    linearSessionId: string,
  ): Promise<PendingQuestion | null> {
    return this.kv.get<PendingQuestion>(`${QUESTION_PREFIX}${linearSessionId}`);
  }

  async savePendingQuestion(question: PendingQuestion): Promise<void> {
    await this.kv.put(
      `${QUESTION_PREFIX}${question.linearSessionId}`,
      question,
    );
  }

  async deletePendingQuestion(linearSessionId: string): Promise<void> {
    await this.kv.delete(`${QUESTION_PREFIX}${linearSessionId}`);
  }

  async getPendingPermission(
    linearSessionId: string,
  ): Promise<PendingPermission | null> {
    return this.kv.get<PendingPermission>(
      `${PERMISSION_PREFIX}${linearSessionId}`,
    );
  }

  async savePendingPermission(permission: PendingPermission): Promise<void> {
    await this.kv.put(
      `${PERMISSION_PREFIX}${permission.linearSessionId}`,
      permission,
    );
  }

  async deletePendingPermission(linearSessionId: string): Promise<void> {
    await this.kv.delete(`${PERMISSION_PREFIX}${linearSessionId}`);
  }
}
