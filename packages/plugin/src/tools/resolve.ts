/**
 * Resolution helpers — resolve human-readable names to Linear UUIDs.
 * Each resolver returns the matched ID or undefined, pushing actionable
 * warnings when resolution fails.
 *
 * All resolvers that query paginated connections will fetch additional pages
 * until the match is found or all pages are exhausted.
 */

import type { LinearClient } from "@linear/sdk";

interface Paginated<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
  fetchNext(): Promise<Paginated<T>>;
}

async function findInPages<T>(
  first: Paginated<T>,
  predicate: (item: T) => boolean,
): Promise<{ match: T | undefined; all: T[] }> {
  let page = first;
  const all: T[] = [...page.nodes];
  const match = page.nodes.find(predicate);
  if (match) return { match, all };

  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    all.push(...page.nodes);
    const found = page.nodes.find(predicate);
    if (found) return { match: found, all };
  }
  return { match: undefined, all };
}

export async function resolveTeam(
  client: LinearClient,
  team: string,
  warnings: string[],
): Promise<string | undefined> {
  const teams = await client.teams();
  const { match, all } = await findInPages(
    teams,
    (t) =>
      t.id === team ||
      t.key.toLowerCase() === team.toLowerCase() ||
      t.name.toLowerCase() === team.toLowerCase(),
  );
  if (match) return match.id;
  warnings.push(
    `Team "${team}" not found. Available: ${all.map((t) => `${t.name} (${t.key})`).join(", ")}`,
  );
  return undefined;
}

export async function resolveProjectLabels(
  client: LinearClient,
  labels: string[],
  warnings: string[],
): Promise<string[]> {
  const first = await client.projectLabels();
  const allLabels: Array<{ id: string; name: string }> = [...first.nodes];
  let page = first;
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    allLabels.push(...page.nodes);
  }

  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const name of labels) {
    const match = allLabels.find(
      (l) => l.id === name || l.name.toLowerCase() === name.toLowerCase(),
    );
    if (match) {
      ids.push(match.id);
    } else {
      unresolved.push(name);
    }
  }
  if (unresolved.length > 0) {
    warnings.push(
      `Project labels not found: ${unresolved.join(", ")}. Available: ${allLabels.map((l) => l.name).join(", ")}`,
    );
  }
  return ids;
}

export async function resolveUser(
  client: LinearClient,
  assignee: string,
  warnings: string[],
): Promise<string | undefined> {
  if (assignee === "me") {
    const me = await client.viewer;
    return me.id;
  }
  const org = await client.organization;
  const users = await org.users();
  const { match, all } = await findInPages(
    users,
    (u) =>
      u.id === assignee ||
      u.name.toLowerCase() === assignee.toLowerCase() ||
      u.email.toLowerCase() === assignee.toLowerCase(),
  );
  if (match) return match.id;
  warnings.push(
    `User "${assignee}" not found. Available: ${all.map((u) => u.name).join(", ")}`,
  );
  return undefined;
}

export async function resolveState(
  client: LinearClient,
  teamId: string,
  state: string,
  warnings: string[],
): Promise<string | undefined> {
  const team = await client.team(teamId);
  const states = await team.states();
  const { match, all } = await findInPages(
    states,
    (s) =>
      s.id === state ||
      s.name.toLowerCase() === state.toLowerCase() ||
      s.type.toLowerCase() === state.toLowerCase(),
  );
  if (match) return match.id;
  warnings.push(
    `State "${state}" not found. Available: ${all.map((s) => s.name).join(", ")}`,
  );
  return undefined;
}

export async function resolveLabels(
  client: LinearClient,
  teamId: string,
  labels: string[],
  warnings: string[],
): Promise<string[]> {
  const team = await client.team(teamId);
  const first = await team.labels();
  const allLabels: Array<{ id: string; name: string }> = [...first.nodes];
  let page = first;
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    allLabels.push(...page.nodes);
  }

  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const name of labels) {
    const match = allLabels.find(
      (l) => l.id === name || l.name.toLowerCase() === name.toLowerCase(),
    );
    if (match) {
      ids.push(match.id);
    } else {
      unresolved.push(name);
    }
  }
  if (unresolved.length > 0) {
    warnings.push(
      `Labels not found: ${unresolved.join(", ")}. Available: ${allLabels.map((l) => l.name).join(", ")}`,
    );
  }
  return ids;
}

export async function resolveProject(
  client: LinearClient,
  project: string,
  warnings: string[],
): Promise<string | undefined> {
  const projects = await client.projects();
  const { match, all } = await findInPages(
    projects,
    (p) => p.id === project || p.name.toLowerCase() === project.toLowerCase(),
  );
  if (match) return match.id;
  warnings.push(
    `Project "${project}" not found. Available: ${all.map((p) => p.name).join(", ")}`,
  );
  return undefined;
}

export async function resolveCycle(
  client: LinearClient,
  teamId: string,
  cycle: string,
  warnings: string[],
): Promise<string | undefined> {
  const team = await client.team(teamId);
  const cycles = await team.cycles();
  const { match, all } = await findInPages(
    cycles,
    (c) =>
      c.id === cycle ||
      String(c.number) === cycle ||
      c.name?.toLowerCase() === cycle.toLowerCase(),
  );
  if (match) return match.id;
  warnings.push(
    `Cycle "${cycle}" not found. Available: ${all.map((c) => c.name ?? `#${c.number}`).join(", ")}`,
  );
  return undefined;
}

export async function resolveProjectStatus(
  client: LinearClient,
  status: string,
  warnings: string[],
): Promise<string | undefined> {
  const statuses = await client.projectStatuses();
  const { match, all } = await findInPages(
    statuses,
    (s) =>
      s.id === status ||
      s.name.toLowerCase() === status.toLowerCase() ||
      s.type.toLowerCase() === status.toLowerCase(),
  );
  if (match) return match.id;
  warnings.push(
    `Project status "${status}" not found. Available: ${all.map((s) => s.name).join(", ")}`,
  );
  return undefined;
}
