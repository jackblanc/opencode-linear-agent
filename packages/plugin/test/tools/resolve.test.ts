/* eslint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/promise-function-async */
import { describe, test, expect } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import {
  resolveTeam,
  resolveUser,
  resolveState,
  resolveLabels,
  resolveProject,
  resolveCycle,
  resolveProjectStatus,
} from "../../src/tools/resolve";

function nodes<T>(items: T[]): {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
  fetchNext(): Promise<{
    nodes: T[];
    pageInfo: { hasNextPage: boolean };
    fetchNext(): Promise<unknown>;
  }>;
} {
  return {
    nodes: items,
    pageInfo: { hasNextPage: false },
    fetchNext: () =>
      Promise.resolve({
        nodes: [],
        pageInfo: { hasNextPage: false },
        fetchNext: () => Promise.resolve({}),
      }),
  };
}

function mockTeams(
  teams: Array<{ id: string; key: string; name: string }>,
): LinearClient {
  return {
    teams: () => Promise.resolve(nodes(teams)),
  } as unknown as LinearClient;
}

function mockUsersClient(
  users: Array<{ id: string; name: string; email: string }>,
  viewerId = "viewer-1",
): LinearClient {
  return {
    get viewer() {
      return Promise.resolve({ id: viewerId });
    },
    get organization() {
      return Promise.resolve({
        users: () => Promise.resolve(nodes(users)),
      });
    },
  } as unknown as LinearClient;
}

function mockTeamClient(data: {
  states?: Array<{ id: string; name: string; type: string }>;
  labels?: Array<{ id: string; name: string }>;
  cycles?: Array<{ id: string; number: number; name?: string }>;
}): LinearClient {
  return {
    team: () =>
      Promise.resolve({
        states: () => Promise.resolve(nodes(data.states ?? [])),
        labels: () => Promise.resolve(nodes(data.labels ?? [])),
        cycles: () => Promise.resolve(nodes(data.cycles ?? [])),
      }),
  } as unknown as LinearClient;
}

function mockProjectsClient(
  projects: Array<{ id: string; name: string }>,
): LinearClient {
  return {
    projects: () => Promise.resolve(nodes(projects)),
  } as unknown as LinearClient;
}

describe("resolveTeam", () => {
  const teams = [
    { id: "t1", key: "ENG", name: "Engineering" },
    { id: "t2", key: "DES", name: "Design" },
  ];

  test("matches by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveTeam(mockTeams(teams), "t1", warnings);
    expect(result).toBe("t1");
    expect(warnings).toEqual([]);
  });

  test("matches by key (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveTeam(mockTeams(teams), "eng", warnings);
    expect(result).toBe("t1");
  });

  test("matches by name (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveTeam(mockTeams(teams), "engineering", warnings);
    expect(result).toBe("t1");
  });

  test("returns undefined with warning when not found", async () => {
    const warnings: string[] = [];
    const result = await resolveTeam(mockTeams(teams), "Marketing", warnings);
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Marketing");
    expect(warnings[0]).toContain("Engineering (ENG)");
    expect(warnings[0]).toContain("Design (DES)");
  });
});

describe("resolveUser", () => {
  const users = [
    { id: "u1", name: "Alice Smith", email: "alice@example.com" },
    { id: "u2", name: "Bob Jones", email: "bob@example.com" },
  ];

  test("matches by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveUser(mockUsersClient(users), "u2", warnings);
    expect(result).toBe("u2");
  });

  test("matches by name (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveUser(
      mockUsersClient(users),
      "alice smith",
      warnings,
    );
    expect(result).toBe("u1");
  });

  test("matches by email (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveUser(
      mockUsersClient(users),
      "BOB@EXAMPLE.COM",
      warnings,
    );
    expect(result).toBe("u2");
  });

  test("resolves 'me' to viewer ID", async () => {
    const warnings: string[] = [];
    const result = await resolveUser(
      mockUsersClient(users, "viewer-99"),
      "me",
      warnings,
    );
    expect(result).toBe("viewer-99");
  });

  test("returns undefined with warning when not found", async () => {
    const warnings: string[] = [];
    const result = await resolveUser(
      mockUsersClient(users),
      "Charlie",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Charlie");
    expect(warnings[0]).toContain("Alice Smith");
    expect(warnings[0]).toContain("Bob Jones");
  });
});

describe("resolveState", () => {
  const states = [
    { id: "s1", name: "Triage", type: "triage" },
    { id: "s2", name: "In Progress", type: "started" },
    { id: "s3", name: "Done", type: "completed" },
  ];

  test("matches by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveState(
      mockTeamClient({ states }),
      "team-1",
      "s2",
      warnings,
    );
    expect(result).toBe("s2");
  });

  test("matches by name (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveState(
      mockTeamClient({ states }),
      "team-1",
      "in progress",
      warnings,
    );
    expect(result).toBe("s2");
  });

  test("matches by type (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveState(
      mockTeamClient({ states }),
      "team-1",
      "completed",
      warnings,
    );
    expect(result).toBe("s3");
  });

  test("returns undefined with warning when not found", async () => {
    const warnings: string[] = [];
    const result = await resolveState(
      mockTeamClient({ states }),
      "team-1",
      "Cancelled",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Cancelled");
    expect(warnings[0]).toContain("Triage");
    expect(warnings[0]).toContain("In Progress");
    expect(warnings[0]).toContain("Done");
  });
});

describe("resolveLabels", () => {
  const labels = [
    { id: "l1", name: "Bug" },
    { id: "l2", name: "Feature" },
    { id: "l3", name: "Improvement" },
  ];

  test("resolves all labels by name", async () => {
    const warnings: string[] = [];
    const result = await resolveLabels(
      mockTeamClient({ labels }),
      "team-1",
      ["Bug", "Feature"],
      warnings,
    );
    expect(result).toEqual(["l1", "l2"]);
    expect(warnings).toEqual([]);
  });

  test("resolves by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveLabels(
      mockTeamClient({ labels }),
      "team-1",
      ["l3"],
      warnings,
    );
    expect(result).toEqual(["l3"]);
  });

  test("case-insensitive name matching", async () => {
    const warnings: string[] = [];
    const result = await resolveLabels(
      mockTeamClient({ labels }),
      "team-1",
      ["bug", "FEATURE"],
      warnings,
    );
    expect(result).toEqual(["l1", "l2"]);
  });

  test("partial match — some found, some not", async () => {
    const warnings: string[] = [];
    const result = await resolveLabels(
      mockTeamClient({ labels }),
      "team-1",
      ["Bug", "NonExistent", "Also Missing"],
      warnings,
    );
    expect(result).toEqual(["l1"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("NonExistent");
    expect(warnings[0]).toContain("Also Missing");
    expect(warnings[0]).toContain("Bug");
    expect(warnings[0]).toContain("Feature");
  });

  test("returns empty array when none found", async () => {
    const warnings: string[] = [];
    const result = await resolveLabels(
      mockTeamClient({ labels }),
      "team-1",
      ["Nope"],
      warnings,
    );
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("resolveProject", () => {
  const projects = [
    { id: "p1", name: "Alpha" },
    { id: "p2", name: "Beta Release" },
  ];

  test("matches by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveProject(
      mockProjectsClient(projects),
      "p2",
      warnings,
    );
    expect(result).toBe("p2");
  });

  test("matches by name (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveProject(
      mockProjectsClient(projects),
      "beta release",
      warnings,
    );
    expect(result).toBe("p2");
  });

  test("returns undefined with warning when not found", async () => {
    const warnings: string[] = [];
    const result = await resolveProject(
      mockProjectsClient(projects),
      "Gamma",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Gamma");
    expect(warnings[0]).toContain("Alpha");
    expect(warnings[0]).toContain("Beta Release");
  });
});

describe("resolveCycle", () => {
  const cycles = [
    { id: "c1", number: 1, name: "Sprint 1" },
    { id: "c2", number: 2, name: undefined },
    { id: "c3", number: 3, name: "Q1 Planning" },
  ];

  test("matches by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveCycle(
      mockTeamClient({ cycles }),
      "team-1",
      "c2",
      warnings,
    );
    expect(result).toBe("c2");
  });

  test("matches by number string", async () => {
    const warnings: string[] = [];
    const result = await resolveCycle(
      mockTeamClient({ cycles }),
      "team-1",
      "3",
      warnings,
    );
    expect(result).toBe("c3");
  });

  test("matches by name (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveCycle(
      mockTeamClient({ cycles }),
      "team-1",
      "sprint 1",
      warnings,
    );
    expect(result).toBe("c1");
  });

  test("returns undefined with warning when not found", async () => {
    const warnings: string[] = [];
    const result = await resolveCycle(
      mockTeamClient({ cycles }),
      "team-1",
      "Sprint 99",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Sprint 99");
    expect(warnings[0]).toContain("Sprint 1");
    expect(warnings[0]).toContain("#2");
    expect(warnings[0]).toContain("Q1 Planning");
  });
});

function mockProjectStatusesClient(
  statuses: Array<{ id: string; name: string; type: string }>,
): LinearClient {
  return {
    projectStatuses: () => Promise.resolve(nodes(statuses)),
  } as unknown as LinearClient;
}

describe("resolveProjectStatus", () => {
  const statuses = [
    { id: "ps1", name: "Backlog", type: "backlog" },
    { id: "ps2", name: "In Progress", type: "started" },
    { id: "ps3", name: "Done", type: "completed" },
  ];

  test("matches by ID", async () => {
    const warnings: string[] = [];
    const result = await resolveProjectStatus(
      mockProjectStatusesClient(statuses),
      "ps2",
      warnings,
    );
    expect(result).toBe("ps2");
    expect(warnings).toEqual([]);
  });

  test("matches by name (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveProjectStatus(
      mockProjectStatusesClient(statuses),
      "in progress",
      warnings,
    );
    expect(result).toBe("ps2");
  });

  test("matches by type (case-insensitive)", async () => {
    const warnings: string[] = [];
    const result = await resolveProjectStatus(
      mockProjectStatusesClient(statuses),
      "completed",
      warnings,
    );
    expect(result).toBe("ps3");
  });

  test("returns undefined with warning when not found", async () => {
    const warnings: string[] = [];
    const result = await resolveProjectStatus(
      mockProjectStatusesClient(statuses),
      "Archived",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Archived");
    expect(warnings[0]).toContain("Backlog");
    expect(warnings[0]).toContain("In Progress");
    expect(warnings[0]).toContain("Done");
  });
});
