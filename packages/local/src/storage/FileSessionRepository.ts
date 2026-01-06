/**
 * File-based implementation of SessionRepository
 *
 * Wraps FileStore for session-specific operations.
 */

import type { KeyValueStore } from "@linear-opencode-agent/core";
import type {
  SessionRepository,
  SessionState,
} from "@linear-opencode-agent/core";

/**
 * Key prefix for session storage
 */
const SESSION_PREFIX = "session:";

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
}
