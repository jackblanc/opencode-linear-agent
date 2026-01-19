import { describe, test, expect, mock } from "bun:test";
import { Result } from "better-result";
import { WorktreeCleanupService } from "../../src/session/WorktreeCleanupService";
import type { SessionRepository } from "../../src/session/SessionRepository";
import type { Logger } from "../../src/logger";

function createMockLogger(): Logger {
  const logger: Logger = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    tag: mock(() => logger),
    clone: mock(() => logger),
  };
  return logger;
}

function createMockRepository(
  worktreeInfo: { workdir: string; branchName: string } | null = null,
): SessionRepository {
  return {
    get: mock(async () => null),
    save: mock(async () => {}),
    delete: mock(async () => {}),
    findWorktreeByIssue: mock(async () => worktreeInfo),
    deleteWorktreeByIssue: mock(async () => {}),
    getPendingQuestion: mock(async () => null),
    savePendingQuestion: mock(async () => {}),
    deletePendingQuestion: mock(async () => {}),
    getPendingPermission: mock(async () => null),
    savePendingPermission: mock(async () => {}),
    deletePendingPermission: mock(async () => {}),
  };
}

describe("WorktreeCleanupService", () => {
  describe("cleanup", () => {
    test("returns early when no worktree exists for issue", async () => {
      const repository = createMockRepository(null);
      const service = new WorktreeCleanupService(repository);
      const log = createMockLogger();

      const result = await service.cleanup("CODE-123", log);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.issueId).toBe("CODE-123");
        expect(result.value.workdir).toBe(null);
        expect(result.value.gitWorktreeRemoved).toBe(false);
        expect(result.value.directoryRemoved).toBe(false);
        expect(result.value.storageCleared).toBe(false);
      }

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock assertions require unbound method access
      expect(repository.findWorktreeByIssue).toHaveBeenCalledWith("CODE-123");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock assertions require unbound method access
      expect(repository.deleteWorktreeByIssue).not.toHaveBeenCalled();
    });

    test("clears storage when worktree exists", async () => {
      const worktreeInfo = {
        workdir: "/tmp/test-worktree",
        branchName: "code-123",
      };
      const repository = createMockRepository(worktreeInfo);
      const service = new WorktreeCleanupService(repository);
      const log = createMockLogger();

      const result = await service.cleanup("CODE-123", log);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.issueId).toBe("CODE-123");
        expect(result.value.workdir).toBe("/tmp/test-worktree");
        expect(result.value.storageCleared).toBe(true);
      }

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock assertions require unbound method access
      expect(repository.deleteWorktreeByIssue).toHaveBeenCalledWith("CODE-123");
    });

    test("logs worktree info on cleanup", async () => {
      const worktreeInfo = {
        workdir: "/tmp/test-worktree",
        branchName: "code-123",
      };
      const repository = createMockRepository(worktreeInfo);
      const service = new WorktreeCleanupService(repository);
      const log = createMockLogger();

      await service.cleanup("CODE-123", log);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock assertions require unbound method access
      expect(log.info).toHaveBeenCalled();
    });
  });
});
