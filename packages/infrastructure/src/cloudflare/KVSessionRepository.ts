import type {
  SessionRepository,
  SessionState,
} from "@linear-opencode-agent/core";
import type { KeyValueStore } from "../types";

/**
 * KV-backed implementation of SessionRepository
 */
export class KVSessionRepository implements SessionRepository {
  private readonly prefix = "session:";

  constructor(private readonly kv: KeyValueStore) {}

  async get(linearSessionId: string): Promise<SessionState | null> {
    return this.kv.get<SessionState>(`${this.prefix}${linearSessionId}`);
  }

  async save(state: SessionState): Promise<void> {
    await this.kv.put(`${this.prefix}${state.linearSessionId}`, state);
  }

  async delete(linearSessionId: string): Promise<void> {
    await this.kv.delete(`${this.prefix}${linearSessionId}`);
  }
}
