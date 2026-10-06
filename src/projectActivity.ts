export interface ProjectActivityCommit { oid: string; committedAt: number }
export interface ProjectActivitySummary { commits: ProjectActivityCommit[]; checkedAt: number }
export interface ActivityEntry { summary: ProjectActivitySummary | null; error: string | null; checking: boolean }
export interface StoredActivityEntry { path: string; scopeKey: string; value: ActivityEntry }
export interface ActivityWindow { key: string; fromTimestamp: number; toTimestamp: number; start: Date; end: Date }
export interface ActivityDay {
  key: string;
  date: Date;
  count: number;
  projects: { id: string; count: number }[];
}
interface ActivityProject { id: string }
export interface ActivityRequest { key: string; window: ActivityWindow; authorEmails: readonly string[] }
interface CachedActivity { key: string; summary: ProjectActivitySummary | null; error: string | null }

/** Names and default selection do not change which configured authors are ours. */
export function activityAuthorEmails(identities: readonly { email: string }[]): string[] {
  return [...new Set(identities.map(({ email }) => email.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase())).filter(Boolean))].sort();
}

/** Never show a snapshot from another repository, calendar, or identity set. */
export function activityEntryForScope(stored: StoredActivityEntry | undefined, path: string, scopeKey: string): ActivityEntry | null {
  return stored?.path === path && stored.scopeKey === scopeKey ? stored.value : null;
}

/** Session-only cache: keep completed native reads when the workbench is hidden. */
export function createActivityCache(load: (path: string, fromTimestamp: number, toTimestamp: number, authorEmails: readonly string[]) => Promise<ProjectActivitySummary>) {
  const records = new Map<string, CachedActivity>();
  const inFlight = new Map<string, { key: string; promise: Promise<ProjectActivitySummary> }>();
  let retainedPaths: Set<string> | null = null;
  return {
    retain(paths: readonly string[]) {
      retainedPaths = new Set(paths);
      for (const path of records.keys()) if (!retainedPaths.has(path)) records.delete(path);
    },
    get(path: string, key: string): CachedActivity | undefined {
      const record = records.get(path);
      return record?.key === key ? record : undefined;
    },
    read(path: string, request: ActivityRequest): Promise<ProjectActivitySummary> {
      const cached = records.get(path);
      if (cached?.key === request.key) return cached.error !== null
        ? Promise.reject(new Error(cached.error)) : Promise.resolve(cached.summary!);
      const running = inFlight.get(path);
      if (running?.key === request.key) return running.promise;
      const canStore = () => inFlight.get(path)?.promise === promise && (!retainedPaths || retainedPaths.has(path));
      const promise = Promise.resolve().then(() => load(path, request.window.fromTimestamp, request.window.toTimestamp, request.authorEmails)).then(
        (summary) => {
          if (canStore()) records.set(path, { key: request.key, summary, error: null });
          return summary;
        },
        (cause) => {
          if (canStore()) records.set(path, { key: request.key, summary: null, error: cause instanceof Error ? cause.message : String(cause) });
          throw cause;
        },
      ).finally(() => { if (inFlight.get(path)?.promise === promise) inFlight.delete(path); });
      inFlight.set(path, { key: request.key, promise });
      return promise;
    },
  };
}

/** Calendar boundaries use local midnight, including across daylight-saving changes. */
export function activityDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createActivityWindow(now = new Date()): ActivityWindow {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastDay = new Date(end.getFullYear() - 1, end.getMonth() + 1, 0).getDate();
  const start = new Date(end.getFullYear() - 1, end.getMonth(), Math.min(end.getDate(), lastDay));
  start.setDate(start.getDate() + 1);
  const tomorrow = new Date(end);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fromTimestamp = Math.floor(start.getTime() / 1000);
  const toTimestamp = Math.floor(tomorrow.getTime() / 1000);
  return { key: `${fromTimestamp}:${toTimestamp}`, fromTimestamp, toTimestamp, start, end };
}

export function aggregateProjectActivity(projects: readonly ActivityProject[], entries: Record<string, ActivityEntry>, window: ActivityWindow) {
  const days: ActivityDay[] = [];
  const byDay = new Map<string, ActivityDay>();
  for (const date = new Date(window.start); date <= window.end; date.setDate(date.getDate() + 1)) {
    const key = activityDateKey(date);
    const day = { key, date: new Date(date), count: 0, projects: [] };
    days.push(day);
    byDay.set(key, day);
  }
  const commits = new Map<string, { day: ActivityDay; projects: Set<string> }>();
  const projectCounts = new Map<string, Map<string, number>>();
  for (const project of projects) {
    // Failed reads retain their snapshot for error context, not current totals.
    if (entries[project.id]?.error != null) continue;
    for (const commit of entries[project.id]?.summary?.commits ?? []) {
      if (!commit.oid || !Number.isFinite(commit.committedAt)
        || commit.committedAt < window.fromTimestamp || commit.committedAt >= window.toTimestamp) continue;
      const oid = commit.oid.toLowerCase();
      let seen = commits.get(oid);
      if (!seen) {
        const day = byDay.get(activityDateKey(new Date(commit.committedAt * 1000)));
        if (!day) continue;
        seen = { day, projects: new Set() };
        commits.set(oid, seen);
        day.count++;
      }
      if (seen.projects.has(project.id)) continue;
      seen.projects.add(project.id);
      let counts = projectCounts.get(seen.day.key);
      if (!counts) { counts = new Map(); projectCounts.set(seen.day.key, counts); }
      counts.set(project.id, (counts.get(project.id) ?? 0) + 1);
    }
  }
  let activeDays = 0;
  let peakCount = 0;
  for (const day of days) {
    day.projects = [...(projectCounts.get(day.key) ?? [])].map(([id, count]) => ({ id, count }));
    if (day.count) activeDays++;
    peakCount = Math.max(peakCount, day.count);
  }
  const cells: (ActivityDay | null)[] = Array.from({ length: window.start.getDay() }, () => null);
  cells.push(...days);
  while (cells.length % 7) cells.push(null);
  const weeks: (ActivityDay | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return { days, weeks, totalCommits: commits.size, activeDays, peakCount };
}

export function activityIntensity(count: number, peak: number): number {
  return count <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.log1p(count) / Math.log1p(Math.max(count, peak)) * 4)));
}

/** One tab stop, with arrows moving through calendar rows and columns. */
export function activityKeyboardIndex(index: number, key: string, dayCount: number): number | null {
  const shift: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
  if (key === "Home") return 0;
  if (key === "End") return dayCount - 1;
  if (!(key in shift)) return null;
  return Math.max(0, Math.min(dayCount - 1, index + shift[key]));
}
