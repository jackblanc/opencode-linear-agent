import { describe, test, expect } from "bun:test";
import { parseRepoLabel } from "../../src/linear/label-parser";

describe("parseRepoLabel", () => {
  test("should parse simple repo label", () => {
    const labels = [
      {
        name: "repo:linear-opencode-agent",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toEqual({
      repositoryName: "linear-opencode-agent",
    });
  });

  test("should parse repo label with organization", () => {
    const labels = [
      {
        name: "repo:jackblanc/my-project",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toEqual({
      organizationName: "jackblanc",
      repositoryName: "my-project",
    });
  });

  test("should return null for non-repo labels", () => {
    const labels = [
      {
        name: "bug",
      },
      {
        name: "enhancement",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toBeNull();
  });

  test("should return null for empty repo label", () => {
    const labels = [
      {
        name: "repo:",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toBeNull();
  });

  test("should return null for invalid repo format with organization", () => {
    const labels = [
      {
        name: "repo:/invalid",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toBeNull();
  });

  test("should handle mixed labels and find the repo one", () => {
    const labels = [
      {
        name: "bug",
      },
      {
        name: "repo:linear-opencode-agent",
      },
      {
        name: "priority:high",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toEqual({
      repositoryName: "linear-opencode-agent",
    });
  });

  test("should trim whitespace from repo names", () => {
    const labels = [
      {
        name: "repo: my-repo ",
      },
    ];

    const result = parseRepoLabel(labels);

    expect(result).toEqual({
      repositoryName: "my-repo",
    });
  });

  test("should return null for empty labels array", () => {
    const result = parseRepoLabel([]);

    expect(result).toBeNull();
  });
});
