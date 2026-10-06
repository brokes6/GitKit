import type { BehindBranch } from "./git";

export interface ProjectStatusSummary {
  initialized: boolean;
  currentBranch: string;
  changedFiles: number;
  checkedAt: number;
}

/** A read-only snapshot. Ahead/behind compare local remote-tracking refs. */
export interface ProjectOverviewSummary extends ProjectStatusSummary {
  hasHead: boolean;
  detached: boolean;
  hasRemotes: boolean;
  upstream: string | null;
  upstreamRemote: boolean;
  upstreamMissing: boolean;
  ahead: number | null;
  behind: number | null;
  stagedFiles: number;
  unstagedFiles: number;
  conflictFiles: number;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  behindBranches: BehindBranch[];
}

export interface ProjectStatusEntry {
  summary: ProjectStatusSummary | null;
  error: string | null;
  checking: boolean;
  remoteError: string | null;
  readRevision?: number;
  readPath?: string;
}

export interface OverviewEntry extends ProjectStatusEntry { summary: ProjectOverviewSummary | null }

export interface ProjectReadContext {
  paths: readonly string[];
  running: boolean;
  foregroundRevision?: number;
  full: boolean;
  activePath: string;
  revision: number | string;
  remoteRows: readonly { path: string; currentBranch: string; dirty: boolean; behind: readonly BehindBranch[]; error: string | null }[];
}

/** Only repository-affecting result fields invalidate local reads. */
export function projectRemoteRowsKey(rows: ProjectReadContext["remoteRows"]): string {
  return JSON.stringify(rows.map(({ path, currentBranch, dirty, behind, error }) =>
    [path, currentBranch, dirty, behind, error]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Resume reconciles unknown external edits; ordinary updates stay path-scoped. */
export function projectReadTargets(previous: ProjectReadContext | null, current: ProjectReadContext): string[] {
  if (!current.running) return [];
  const paths = new Set(current.paths);
  if (!previous?.running || (current.foregroundRevision ?? 0) !== (previous.foregroundRevision ?? 0)
      || (current.full && !previous.full)) return [...paths];
  const targets = new Set(current.paths.filter((path) => !previous.paths.includes(path)));
  if (previous.revision !== current.revision && paths.has(current.activePath)) targets.add(current.activePath);
  const fingerprints = (rows: ProjectReadContext["remoteRows"]) => new Map(rows.map((row) =>
    [row.path, projectRemoteRowsKey([row])]));
  const oldRows = fingerprints(previous.remoteRows);
  const newRows = fingerprints(current.remoteRows);
  for (const path of new Set([...oldRows.keys(), ...newRows.keys()])) {
    if (paths.has(path) && oldRows.get(path) !== newRows.get(path)) targets.add(path);
  }
  return [...targets];
}

/** A retained generation is context until this scan publishes a fresh entry. */
export function overviewEntryForScan(entry: OverviewEntry, storedScanKey: string | null, scanKey: string, active: boolean): OverviewEntry {
  const checking = active && (entry.checking || storedScanKey !== scanKey);
  return checking === entry.checking ? entry : { ...entry, checking };
}

/** Live watcher results win over any overview read started before their update. */
export function applyOverviewToProjects<T extends { id: string; path: string; initialized?: boolean; branch: string; changes: number }>(
  projects: T[], entries: Readonly<Record<string, ProjectStatusEntry | undefined>>, activePath: string,
  liveRevisions: ReadonlyMap<string, number>,
): T[] {
  let changed = false;
  const next = projects.map((project) => {
    const entry = entries[project.id];
    if (project.path === activePath || !entry?.summary || entry.checking || entry.error || entry.readPath !== project.path || entry.readRevision === undefined
        || entry.readRevision !== (liveRevisions.get(project.path) ?? 0)) return project;
    const { initialized, currentBranch, changedFiles } = entry.summary;
    if (project.initialized === initialized && project.branch === currentBranch && project.changes === changedFiles) return project;
    changed = true;
    return { ...project, initialized, branch: currentBranch, changes: changedFiles };
  });
  return changed ? next : projects;
}
export type OverviewTarget = "repository" | "changes" | "conflicts" | "history" | "updates" | "settings";
export type OverviewFilter = "attention" | "conflicts" | "changes" | "ahead" | "behind" | "error" | "all";
export type OverviewState = "conflict" | "operation" | "diverged" | "changes" | "ahead" | "behind"
  | "error" | "uninitialized" | "unborn" | "detached" | "missing-upstream" | "untracked" | "local" | "local-ahead" | "clean" | "unknown";

export const OVERVIEW_FILTERS: OverviewFilter[] = ["attention", "conflicts", "changes", "ahead", "behind", "error", "all"];
const EMPTY_ENTRY: OverviewEntry = { summary: null, error: null, checking: false, remoteError: null };

export function overviewState(entry: OverviewEntry = EMPTY_ENTRY): OverviewState {
  const summary = entry.summary;
  // A retained snapshot after a failed read is context, never current truth.
  if (entry.error) return "error";
  if (!summary) return entry.error || entry.remoteError ? "error" : "unknown";
  if (summary.conflictFiles > 0) return "conflict";
  if (summary.operation) return "operation";
  if ((summary.ahead ?? 0) > 0 && (summary.behind ?? 0) > 0) return "diverged";
  if (summary.changedFiles > 0) return "changes";
  if ((summary.ahead ?? 0) > 0) return summary.upstreamRemote ? "ahead" : "local-ahead";
  if ((summary.behind ?? 0) > 0 || summary.behindBranches.length > 0) return "behind";
  if (entry.error || entry.remoteError) return "error";
  if (!summary.initialized) return "uninitialized";
  if (!summary.hasHead) return "unborn";
  if (summary.detached) return "detached";
  if (summary.upstreamMissing) return "missing-upstream";
  if (!summary.hasRemotes) return "local";
  if (!summary.upstream || summary.ahead === null || summary.behind === null) return "untracked";
  return "clean";
}

export function overviewMatchesFilter(entry: OverviewEntry | undefined, filter: OverviewFilter): boolean {
  if (filter === "all") return true;
  const value = entry ?? EMPTY_ENTRY;
  const summary = value.summary;
  if (value.error) return filter === "attention" || filter === "error";
  switch (filter) {
    case "conflicts": return (summary?.conflictFiles ?? 0) > 0;
    case "changes": return (summary?.changedFiles ?? 0) > 0;
    case "ahead": return !!summary?.upstreamRemote && (summary.ahead ?? 0) > 0;
    case "behind": return (summary?.behind ?? 0) > 0 || (summary?.behindBranches.length ?? 0) > 0;
    case "error": return !!value.error || !!value.remoteError || !!summary?.upstreamMissing;
    case "attention": {
      if (value.error || value.remoteError) return true;
      const state = overviewState(value);
      return state !== "clean" && state !== "local" && state !== "untracked";
    }
  }
}

interface OverviewProject { id: string; name: string; path: string }
export function overviewFilterCounts(projects: readonly OverviewProject[], entries: Record<string, OverviewEntry>): Record<OverviewFilter, number> {
  const counts = Object.fromEntries(OVERVIEW_FILTERS.map((filter) => [filter, 0])) as Record<OverviewFilter, number>;
  for (const project of projects) {
    const entry = entries[project.id];
    for (const filter of OVERVIEW_FILTERS) {
      if (filter === "attention" && !entry?.summary && !entry?.error && !entry?.remoteError) continue;
      if (overviewMatchesFilter(entry, filter)) counts[filter]++;
    }
  }
  return counts;
}
export function overviewAttentionCount(projects: readonly OverviewProject[], entries: Record<string, OverviewEntry>): number {
  return projects.filter((project) => {
    const entry = entries[project.id];
    return !!(entry?.summary || entry?.error || entry?.remoteError) && overviewMatchesFilter(entry, "attention");
  }).length;
}

const STATE_ORDER: Record<OverviewState, number> = {
  conflict: 0, operation: 1, diverged: 2, changes: 3, ahead: 4, "local-ahead": 4, behind: 5, error: 6,
  "missing-upstream": 7, uninitialized: 8, unborn: 9, detached: 10, unknown: 11, untracked: 12, local: 13, clean: 14,
};
export function selectOverviewProjects<T extends OverviewProject>(
  projects: readonly T[], entries: Record<string, OverviewEntry>, filter: OverviewFilter, query: string,
): T[] {
  const search = query.trim().toLocaleLowerCase();
  return projects.filter((project) => {
    if (!overviewMatchesFilter(entries[project.id], filter)) return false;
    if (!search) return true;
    const summary = entries[project.id]?.summary;
    return [project.name, project.path, summary?.currentBranch ?? "", summary?.upstream ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(search));
  }).sort((left, right) => STATE_ORDER[overviewState(entries[left.id])] - STATE_ORDER[overviewState(entries[right.id])]);
}

export function overviewTarget(entry: OverviewEntry | undefined): OverviewTarget {
  switch (overviewState(entry)) {
    case "conflict": return "conflicts";
    case "operation": case "changes": return "changes";
    case "ahead": case "local-ahead": return "history";
    case "diverged": case "behind": return "updates";
    case "error": return !entry?.error && entry?.remoteError ? "updates" : "repository";
    default: return "repository";
  }
}
