import type { Result as ResultType } from "better-result";

import { Result } from "better-result";

import type { KvError } from "../kv/errors";
import type { AgentStateNamespace } from "./root";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
  SessionState,
} from "./schema";

export class SessionRepository {
  constructor(private readonly agentState: AgentStateNamespace) {}

  async get(linearSessionId: string): Promise<ResultType<SessionState, KvError>> {
    return this.agentState.session.get(linearSessionId);
  }

  async save(state: SessionState): Promise<ResultType<void, KvError>> {
    const root = this.agentState;
    const sessionStore = root.session;
    const indexStore = root.sessionByOpencode;

    return sessionStore.withOperationLock(`session:${state.linearSessionId}`, async () =>
      Result.gen(async function* () {
        const hasExisting = yield* Result.await(sessionStore.has(state.linearSessionId));

        let existingState: SessionState | null = null;
        if (hasExisting) {
          existingState = yield* Result.await(sessionStore.get(state.linearSessionId));
        }

        const rollback = async (error: KvError): Promise<ResultType<undefined, KvError>> =>
          Result.gen(async function* () {
            yield* Result.await(
              existingState
                ? sessionStore.put(state.linearSessionId, existingState)
                : sessionStore.delete(state.linearSessionId),
            );

            yield* Result.await(indexStore.delete(state.opencodeSessionId));

            if (existingState) {
              yield* Result.await(
                indexStore.put(existingState.opencodeSessionId, {
                  linearSessionId: existingState.linearSessionId,
                }),
              );
            }

            return Result.err(error);
          });

        yield* Result.await(sessionStore.put(state.linearSessionId, state));

        if (existingState && existingState.opencodeSessionId !== state.opencodeSessionId) {
          const removed = await indexStore.delete(existingState.opencodeSessionId);
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

  async delete(linearSessionId: string): Promise<ResultType<void, KvError>> {
    const root = this.agentState;
    const sessionStore = root.session;
    const indexStore = root.sessionByOpencode;

    return sessionStore.withOperationLock(`session:${linearSessionId}`, async () =>
      Result.gen(async function* () {
        const hasExisting = yield* Result.await(sessionStore.has(linearSessionId));

        let existingState: SessionState | null = null;
        if (hasExisting) {
          existingState = yield* Result.await(sessionStore.get(linearSessionId));
        }

        yield* Result.await(sessionStore.delete(linearSessionId));

        if (existingState) {
          yield* Result.await(indexStore.delete(existingState.opencodeSessionId));
        }

        yield* Result.await(root.question.delete(linearSessionId));
        yield* Result.await(root.permission.delete(linearSessionId));
        yield* Result.await(root.repoSelection.delete(linearSessionId));

        return Result.ok(undefined);
      }),
    );
  }

  async getPendingQuestion(linearSessionId: string): Promise<ResultType<PendingQuestion, KvError>> {
    return this.agentState.question.get(linearSessionId);
  }

  async savePendingQuestion(question: PendingQuestion): Promise<ResultType<void, KvError>> {
    return this.agentState.question.put(question.linearSessionId, question);
  }

  async deletePendingQuestion(linearSessionId: string): Promise<ResultType<void, KvError>> {
    return this.agentState.question.delete(linearSessionId);
  }

  async getPendingPermission(
    linearSessionId: string,
  ): Promise<ResultType<PendingPermission, KvError>> {
    return this.agentState.permission.get(linearSessionId);
  }

  async savePendingPermission(permission: PendingPermission): Promise<ResultType<void, KvError>> {
    return this.agentState.permission.put(permission.linearSessionId, permission);
  }

  async deletePendingPermission(linearSessionId: string): Promise<ResultType<void, KvError>> {
    return this.agentState.permission.delete(linearSessionId);
  }

  async getPendingRepoSelection(
    linearSessionId: string,
  ): Promise<ResultType<PendingRepoSelection, KvError>> {
    return this.agentState.repoSelection.get(linearSessionId);
  }

  async savePendingRepoSelection(
    selection: PendingRepoSelection,
  ): Promise<ResultType<void, KvError>> {
    return this.agentState.repoSelection.put(selection.linearSessionId, selection);
  }

  async deletePendingRepoSelection(linearSessionId: string): Promise<ResultType<void, KvError>> {
    return this.agentState.repoSelection.delete(linearSessionId);
  }
}
