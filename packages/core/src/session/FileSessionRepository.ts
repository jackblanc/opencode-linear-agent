import { Result } from "better-result";

import type { KvError } from "../kv/errors";
import { getStateRootPath } from "../utils/paths";
import { createFileAgentState } from "../state/root";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
  SessionRepository,
} from "./SessionRepository";
import type { SessionState } from "./SessionState";

export class FileSessionRepository implements SessionRepository {
  constructor(private readonly statePath = getStateRootPath()) {}

  private getState() {
    return createFileAgentState(this.statePath);
  }

  private async getOptional<T>(
    store: {
      has(key: string): Promise<Result<boolean, KvError>>;
      get(key: string): Promise<Result<T, KvError>>;
    },
    key: string,
  ): Promise<T | null> {
    const hasValue = await store.has(key);
    if (Result.isError(hasValue)) {
      throw new Error(hasValue.error.message);
    }
    if (!hasValue.value) {
      return null;
    }

    const result = await store.get(key);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }

    return result.value;
  }

  async get(linearSessionId: string): Promise<SessionState | null> {
    return this.getOptional(this.getState().session, linearSessionId);
  }

  async save(state: SessionState): Promise<void> {
    const root = this.getState();
    const sessionStore = root.session;
    const indexStore = root.sessionByOpencode;

    const result = await sessionStore.withOperationLock(
      `session:${state.linearSessionId}`,
      async () => {
        const hasExisting = await sessionStore.has(state.linearSessionId);
        if (Result.isError(hasExisting)) {
          return Result.err(hasExisting.error);
        }

        let existingState: SessionState | null = null;
        if (hasExisting.value) {
          const existing = await sessionStore.get(state.linearSessionId);
          if (Result.isError(existing)) {
            return Result.err(existing.error);
          }
          existingState = existing.value;
        }

        const rollback = async (
          error: KvError,
        ): Promise<Result<undefined, KvError>> => {
          const restoredSession = existingState
            ? await sessionStore.put(state.linearSessionId, existingState)
            : await sessionStore.delete(state.linearSessionId);
          if (Result.isError(restoredSession)) {
            return Result.err(restoredSession.error);
          }

          const droppedNewIndex = await indexStore.delete(
            state.opencodeSessionId,
          );
          if (Result.isError(droppedNewIndex)) {
            return Result.err(droppedNewIndex.error);
          }

          if (existingState) {
            const restoredIndex = await indexStore.put(
              existingState.opencodeSessionId,
              {
                linearSessionId: existingState.linearSessionId,
              },
            );
            if (Result.isError(restoredIndex)) {
              return Result.err(restoredIndex.error);
            }
          }

          return Result.err(error);
        };

        const saved = await sessionStore.put(state.linearSessionId, state);
        if (Result.isError(saved)) {
          return Result.err(saved.error);
        }

        if (
          existingState &&
          existingState.opencodeSessionId !== state.opencodeSessionId
        ) {
          const removed = await indexStore.delete(
            existingState.opencodeSessionId,
          );
          if (Result.isError(removed)) {
            return rollback(removed.error);
          }
        }

        const indexed = await indexStore.put(state.opencodeSessionId, {
          linearSessionId: state.linearSessionId,
        });
        if (Result.isError(indexed)) {
          return rollback(indexed.error);
        }

        return Result.ok(undefined);
      },
    );

    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async delete(linearSessionId: string): Promise<void> {
    const root = this.getState();
    const sessionStore = root.session;
    const indexStore = root.sessionByOpencode;

    const result = await sessionStore.withOperationLock(
      `session:${linearSessionId}`,
      async () => {
        const hasExisting = await sessionStore.has(linearSessionId);
        if (Result.isError(hasExisting)) {
          return Result.err(hasExisting.error);
        }

        let existingState: SessionState | null = null;
        if (hasExisting.value) {
          const existing = await sessionStore.get(linearSessionId);
          if (Result.isError(existing)) {
            return Result.err(existing.error);
          }
          existingState = existing.value;
        }

        const removed = await sessionStore.delete(linearSessionId);
        if (Result.isError(removed)) {
          return Result.err(removed.error);
        }

        if (existingState) {
          const dropped = await indexStore.delete(
            existingState.opencodeSessionId,
          );
          if (Result.isError(dropped)) {
            return Result.err(dropped.error);
          }
        }

        const question = await root.question.delete(linearSessionId);
        if (Result.isError(question)) {
          return Result.err(question.error);
        }

        const permission = await root.permission.delete(linearSessionId);
        if (Result.isError(permission)) {
          return Result.err(permission.error);
        }

        const repoSelection = await root.repoSelection.delete(linearSessionId);
        if (Result.isError(repoSelection)) {
          return Result.err(repoSelection.error);
        }

        return Result.ok(undefined);
      },
    );

    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async getPendingQuestion(
    linearSessionId: string,
  ): Promise<PendingQuestion | null> {
    return this.getOptional(this.getState().question, linearSessionId);
  }

  async savePendingQuestion(question: PendingQuestion): Promise<void> {
    const result = await this.getState().question.put(
      question.linearSessionId,
      question,
    );
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async deletePendingQuestion(linearSessionId: string): Promise<void> {
    const result = await this.getState().question.delete(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async getPendingPermission(
    linearSessionId: string,
  ): Promise<PendingPermission | null> {
    return this.getOptional(this.getState().permission, linearSessionId);
  }

  async savePendingPermission(permission: PendingPermission): Promise<void> {
    const result = await this.getState().permission.put(
      permission.linearSessionId,
      permission,
    );
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async deletePendingPermission(linearSessionId: string): Promise<void> {
    const result = await this.getState().permission.delete(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async getPendingRepoSelection(
    linearSessionId: string,
  ): Promise<PendingRepoSelection | null> {
    return this.getOptional(this.getState().repoSelection, linearSessionId);
  }

  async savePendingRepoSelection(
    selection: PendingRepoSelection,
  ): Promise<void> {
    const result = await this.getState().repoSelection.put(
      selection.linearSessionId,
      selection,
    );
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }

  async deletePendingRepoSelection(linearSessionId: string): Promise<void> {
    const result = await this.getState().repoSelection.delete(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
  }
}
