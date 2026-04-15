import type { Result as ResultType } from "better-result";

import { Result } from "better-result";

import type { KvError } from "../kv/errors";
import type { AgentStateNamespace } from "./root";

import { KvNotFoundError } from "../kv/errors";

export class OAuthStateRepository {
  constructor(private readonly agentState: AgentStateNamespace) {}

  async issue(state: string, now: number, expiresAt: number): Promise<ResultType<void, KvError>> {
    const rec = { state, createdAt: now, expiresAt };
    return this.agentState.oauthState.put(state, rec);
  }

  async consume(state: string, now: number): Promise<ResultType<void, KvError>> {
    return Result.gen(
      async function* (this: OAuthStateRepository) {
        const rec = yield* Result.await(this.agentState.oauthState.get(state));
        yield* Result.await(this.agentState.oauthState.delete(state));

        if (rec.expiresAt < now) {
          return Result.err(new KvNotFoundError({ key: state }));
        }

        return Result.ok(undefined);
      }.bind(this),
    );
  }
}
