import type { Result as ResultType } from "better-result";

import { Result } from "better-result";

import type { KvError } from "../kv/errors";
import type { AgentStateNamespace } from "./root";
import type { SessionState } from "./schema";

export async function saveSessionState(
  agentState: AgentStateNamespace,
  state: SessionState,
): Promise<ResultType<void, KvError>> {
  const sessionStore = agentState.session;
  const indexStore = agentState.sessionByOpencode;

  return sessionStore.withOperationLock(`session:${state.linearSessionId}`, async () =>
    Result.gen(async function* () {
      const hasExisting = yield* Result.await(sessionStore.has(state.linearSessionId));
      let existing: SessionState | null = null;
      if (hasExisting) {
        existing = yield* Result.await(sessionStore.get(state.linearSessionId));
      }

      const rollback = async (error: KvError): Promise<ResultType<undefined, KvError>> =>
        Result.gen(async function* () {
          yield* Result.await(
            existing
              ? sessionStore.put(state.linearSessionId, existing)
              : sessionStore.delete(state.linearSessionId),
          );

          yield* Result.await(indexStore.delete(state.opencodeSessionId));

          if (existing) {
            yield* Result.await(
              indexStore.put(existing.opencodeSessionId, {
                linearSessionId: existing.linearSessionId,
              }),
            );
          }

          return Result.err(error);
        });

      yield* Result.await(sessionStore.put(state.linearSessionId, state));

      if (existing && existing.opencodeSessionId !== state.opencodeSessionId) {
        const removed = await indexStore.delete(existing.opencodeSessionId);
        const dropped = removed.isErr() ? await rollback(removed.error) : Result.ok(undefined);
        yield* dropped;
      }

      const indexed = await indexStore.put(state.opencodeSessionId, {
        linearSessionId: state.linearSessionId,
      });
      const stored = indexed.isErr() ? await rollback(indexed.error) : Result.ok(undefined);
      yield* stored;

      return Result.ok(undefined);
    }),
  );
}

export async function deleteSessionState(
  agentState: AgentStateNamespace,
  linearSessionId: string,
): Promise<ResultType<void, KvError>> {
  const sessionStore = agentState.session;
  const indexStore = agentState.sessionByOpencode;

  return sessionStore.withOperationLock(`session:${linearSessionId}`, async () =>
    Result.gen(async function* () {
      const hasExisting = yield* Result.await(sessionStore.has(linearSessionId));

      let existing: SessionState | null = null;
      if (hasExisting) {
        existing = yield* Result.await(sessionStore.get(linearSessionId));
      }

      yield* Result.await(sessionStore.delete(linearSessionId));

      if (existing) {
        yield* Result.await(indexStore.delete(existing.opencodeSessionId));
      }

      yield* Result.await(agentState.question.delete(linearSessionId));
      yield* Result.await(agentState.permission.delete(linearSessionId));
      yield* Result.await(agentState.repoSelection.delete(linearSessionId));

      return Result.ok(undefined);
    }),
  );
}
