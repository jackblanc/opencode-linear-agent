/**
 * File-based implementation of SessionRepository
 *
 * Wraps FileStore for session-specific operations.
 */

import type { KeyValueStore } from "@opencode-linear-agent/core";
import type {
  SessionRepository,
  SessionState,
  PendingQuestion,
  PendingPermission,
  PendingRepoSelection,
} from "@opencode-linear-agent/core";

/**
 * Key prefix for session storage
 */
const SESSION_PREFIX = "session:";

/**
 * Key prefix for pending question storage
 */
const QUESTION_PREFIX = "question:";

/**
 * Key prefix for pending permission storage
 */
const PERMISSION_PREFIX = "permission:";

const REPO_SELECTION_PREFIX = "repo-selection:";

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
  }

  async delete(linearSessionId: string): Promise<void> {
    await this.kv.delete(`${SESSION_PREFIX}${linearSessionId}`);
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

  async getPendingRepoSelection(
    linearSessionId: string,
  ): Promise<PendingRepoSelection | null> {
    return this.kv.get<PendingRepoSelection>(
      `${REPO_SELECTION_PREFIX}${linearSessionId}`,
    );
  }

  async savePendingRepoSelection(
    selection: PendingRepoSelection,
  ): Promise<void> {
    await this.kv.put(
      `${REPO_SELECTION_PREFIX}${selection.linearSessionId}`,
      selection,
    );
  }

  async deletePendingRepoSelection(linearSessionId: string): Promise<void> {
    await this.kv.delete(`${REPO_SELECTION_PREFIX}${linearSessionId}`);
  }
}
