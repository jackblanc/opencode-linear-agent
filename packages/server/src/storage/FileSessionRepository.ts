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
}
