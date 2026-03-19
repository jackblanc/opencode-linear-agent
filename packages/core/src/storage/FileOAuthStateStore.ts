import { Result } from "better-result";

import { getStateRootPath } from "../paths";
import { createFileAgentState } from "../state/root";
import type { OAuthStateRecord } from "../state/schema";

export interface OAuthStateStore {
  issue(state: string, now: number, expiresAt: number): Promise<void>;
  consume(state: string, now: number): Promise<boolean>;
}

export class FileOAuthStateStore implements OAuthStateStore {
  constructor(private readonly statePath = getStateRootPath()) {}

  async issue(state: string, now: number, expiresAt: number): Promise<void> {
    const store = createFileAgentState(this.statePath).oauthState;
    const rec: OAuthStateRecord = { state, createdAt: now, expiresAt };
    const result = await store.put(state, rec);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async consume(state: string, now: number): Promise<boolean> {
    const store = createFileAgentState(this.statePath).oauthState;
    const rec = await store.get(state);
    if (Result.isError(rec)) {
      throw new Error(rec.error.message);
    }
    if (!rec.value) {
      return false;
    }
    if (rec.value.expiresAt < now) {
      const del = await store.delete(state);
      if (Result.isError(del)) {
        throw new Error(del.error.message);
      }
      return false;
    }
    const del = await store.delete(state);
    if (Result.isError(del)) {
      throw new Error(del.error.message);
    }
    return true;
  }
}
