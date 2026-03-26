import { Result } from "better-result";

import type { AgentStateNamespace } from "./root";

export class OAuthStateRepository {
  constructor(private readonly agentState: AgentStateNamespace) {}

  async issue(state: string, now: number, expiresAt: number): Promise<void> {
    const rec = { state, createdAt: now, expiresAt };
    const result = await this.agentState.oauthState.put(state, rec);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async consume(state: string, now: number): Promise<boolean> {
    const hasRecord = await this.agentState.oauthState.has(state);
    if (Result.isError(hasRecord)) {
      throw new Error(hasRecord.error.message);
    }
    if (!hasRecord.value) {
      return false;
    }

    const rec = await this.agentState.oauthState.get(state);
    if (Result.isError(rec)) {
      throw new Error(rec.error.message);
    }
    if (rec.value.expiresAt < now) {
      const del = await this.agentState.oauthState.delete(state);
      if (Result.isError(del)) {
        throw new Error(del.error.message);
      }
      return false;
    }
    const del = await this.agentState.oauthState.delete(state);
    if (Result.isError(del)) {
      throw new Error(del.error.message);
    }
    return true;
  }
}
