import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import type { LinearService } from "@opencode-linear-agent/core";
import { resolveRepoPath } from "../src/RepoResolver";

const TEST_DIR = join(import.meta.dir, ".test-repo-resolver");

function createLinear(labels: string[]): LinearService {
  return {
    postActivity: async () => Result.ok(undefined),
    postStageActivity: async () => Result.ok(undefined),
    postError: async () => Result.ok(undefined),
    postElicitation: async () => Result.ok(undefined),
    setExternalLink: async () => Result.ok(undefined),
    updatePlan: async () => Result.ok(undefined),
    getIssue: async () =>
      Result.ok({
        id: "issue-1",
        identifier: "CODE-1",
        title: "t",
        url: "https://linear.app",
      }),
    getIssueLabels: async () =>
      Result.ok(labels.map((name, i) => ({ id: `label-${i}`, name }))),
    getIssueAttachments: async () => Result.ok([]),
    getIssueRepositorySuggestions: async (
      _issueId,
      _agentSessionId,
      candidates,
    ) =>
      Result.ok(
        candidates
          .map((candidate, i) => ({
            ...candidate,
            confidence: 1 - i * 0.1,
          }))
          .toReversed(),
      ),
    getIssueAgentSessionIds: async () => Result.ok([]),
    moveIssueToInProgress: async () => Result.ok(undefined),
    getIssueState: async () =>
      Result.ok({ id: "state-1", name: "Todo", type: "unstarted" }),
  };
}

describe("resolveRepoPath", () => {
  beforeEach(async () => {
    await mkdir(join(TEST_DIR, "alpha"), { recursive: true });
    await mkdir(join(TEST_DIR, "beta"), { recursive: true });
    await mkdir(join(TEST_DIR, "opencode-linear-agent"), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("resolves simple repo label to repo path", async () => {
    const result = await resolveRepoPath(
      createLinear(["repo:opencode-linear-agent"]),
      "issue-1",
      "session-1",
      TEST_DIR,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value).toEqual({
      status: "resolved",
      path: join(TEST_DIR, "opencode-linear-agent"),
      repoName: "opencode-linear-agent",
    });
  });

  test("resolves org/repo label to local repo basename", async () => {
    const result = await resolveRepoPath(
      createLinear(["repo:jackblanc/opencode-linear-agent"]),
      "issue-1",
      "session-1",
      TEST_DIR,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value).toEqual({
      status: "resolved",
      path: join(TEST_DIR, "opencode-linear-agent"),
      repoName: "opencode-linear-agent",
    });
  });

  test("returns needs_repo_label with ranked suggestions when label missing", async () => {
    const result = await resolveRepoPath(
      createLinear([]),
      "issue-1",
      "session-1",
      TEST_DIR,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result) || result.value.status !== "needs_repo_label") {
      return;
    }

    expect(result.value.reason).toBe("missing");
    const labels = result.value.suggestions.map(
      (suggestion) => suggestion.labelValue,
    );

    expect(labels).toContain("repo:alpha");
    expect(labels).toContain("repo:beta");
    expect(labels).toContain("repo:opencode-linear-agent");
    expect(labels).toContain(result.value.exampleLabel);
  });

  test("treats malformed repo label as invalid config", async () => {
    const result = await resolveRepoPath(
      createLinear(["repo: "]),
      "issue-1",
      "session-1",
      TEST_DIR,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result) || result.value.status !== "needs_repo_label") {
      return;
    }

    expect(result.value.reason).toBe("invalid");
    expect(result.value.invalidLabel).toBe("repo: ");
  });
});
