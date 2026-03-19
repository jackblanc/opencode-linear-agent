import { Result } from "better-result";

import type { KvError } from "../kv/errors";
import { getStateRootPath } from "../paths";
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

  async get(linearSessionId: string): Promise<SessionState | null> {
    const result = await this.getState().session.get(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  async save(state: SessionState): Promise<void> {
    const root = this.getState();
    const sessionStore = root.session;
    const indexStore = root.sessionByOpencode;

    const result = await sessionStore.withOperationLock(
      `session:${state.linearSessionId}`,
      async () => {
        const existing = await sessionStore.get(state.linearSessionId);
        if (Result.isError(existing)) {
          return Result.err(existing.error);
        }

        const rollback = async (
          error: KvError,
        ): Promise<Result<undefined, KvError>> => {
          const restoredSession = existing.value
            ? await sessionStore.put(state.linearSessionId, existing.value)
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

          if (existing.value) {
            const restoredIndex = await indexStore.put(
              existing.value.opencodeSessionId,
              {
                linearSessionId: existing.value.linearSessionId,
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
          existing.value &&
          existing.value.opencodeSessionId !== state.opencodeSessionId
        ) {
          const removed = await indexStore.delete(
            existing.value.opencodeSessionId,
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
        const existing = await sessionStore.get(linearSessionId);
        if (Result.isError(existing)) {
          return Result.err(existing.error);
        }

        const removed = await sessionStore.delete(linearSessionId);
        if (Result.isError(removed)) {
          return Result.err(removed.error);
        }

        if (existing.value) {
          const dropped = await indexStore.delete(
            existing.value.opencodeSessionId,
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
    const result = await this.getState().question.get(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    return result.value;
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
    const result = await this.getState().permission.get(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    return result.value;
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
    const result = await this.getState().repoSelection.get(linearSessionId);
    if (Result.isError(result)) {
      throw new Error(result.error.message);
    }
    return result.value;
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
