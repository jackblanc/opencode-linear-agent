import type { SessionState } from "./SessionState";

/**
 * Repository for session state persistence
 */
export interface SessionRepository {
  /**
   * Get session state by Linear session ID
   */
  get(linearSessionId: string): Promise<SessionState | null>;

  /**
   * Save session state
   */
  save(state: SessionState): Promise<void>;

  /**
   * Delete session state
   */
  delete(linearSessionId: string): Promise<void>;
}
