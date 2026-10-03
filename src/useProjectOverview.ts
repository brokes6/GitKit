import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "./App";
import type { CheckResult } from "./dailyCheck";
import { loadProjectOverview } from "./git";
import { createOverviewScanner } from "./overviewScanner";
import type { OverviewEntry } from "./projectOverview";

interface StoredEntry { path: string; value: OverviewEntry }
interface ScanProject { id: string; path: string }
const IDLE_ENTRY: OverviewEntry = { summary: null, error: null, checking: false, remoteError: null };
const LOADING_ENTRY: OverviewEntry = { ...IDLE_ENTRY, checking: true };

export function useProjectOverview(projects: Project[], active: boolean, revision: number, remoteResult: CheckResult | null) {
  const [stored, setStored] = useState<Record<string, StoredEntry>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const scannerRef = useRef<ReturnType<typeof createOverviewScanner<ScanProject>> | null>(null);
  if (!scannerRef.current) scannerRef.current = createOverviewScanner<ScanProject>(loadProjectOverview);
  const scanner = scannerRef.current;
  const projectedEntries = useRef<Record<string, OverviewEntry>>({});
  // Names, branch labels and cached change counts must not restart repository reads.
  const cohortKey = JSON.stringify(projects.map(({ id, path }) => ({ id, path })));
  const remoteRevision = remoteResult?.id ?? 0;
  const remoteCompletedAt = remoteResult?.completedAt ?? 0;
  const refresh = useCallback(() => setRefreshRevision((value) => value + 1), []);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refresh]);

  useEffect(() => {
    let disposed = false;
    const cohort: ScanProject[] = JSON.parse(cohortKey);
    if (!active || !cohort.length) {
      setRefreshing(false);
      setStored((previous) => {
        let changed = Object.keys(previous).length !== cohort.length;
        const next: Record<string, StoredEntry> = {};
        for (const project of cohort) {
          const entry = previous[project.id];
          if (entry?.path !== project.path) { changed = true; continue; }
          next[project.id] = entry.value.checking
            ? { ...entry, value: { ...entry.value, checking: false } } : entry;
          changed ||= entry.value.checking;
        }
        return changed ? next : previous;
      });
      return;
    }
    setRefreshing(true);
    setStored((previous) => {
      let changed = Object.keys(previous).length !== cohort.length;
      const next: Record<string, StoredEntry> = {};
      for (const project of cohort) {
        const old = previous[project.id]?.path === project.path ? previous[project.id] : null;
        if (old?.value.checking) { next[project.id] = old; continue; }
        changed = true;
        next[project.id] = { path: project.path, value: {
          summary: old?.value.summary ?? null, error: old?.value.error ?? null, checking: true, remoteError: null,
        } };
      }
      return changed ? next : previous;
    });
    const scan = scanner.start(cohort, {
      onBatch: (results) => setStored((previous) => {
        if (disposed) return previous;
        let next = previous;
        for (const { project, summary, error } of results) {
          const old = previous[project.id];
          if (old?.path !== project.path) continue;
          if (next === previous) next = { ...previous };
          next[project.id] = { path: project.path, value: {
            summary: summary ?? old.value.summary, error, checking: false, remoteError: null,
          } };
        }
        return next;
      }),
      onComplete: () => { if (!disposed) setRefreshing(false); },
    });
    return () => { disposed = true; scan.cancel(); };
  }, [active, cohortKey, revision, refreshRevision, remoteRevision, remoteCompletedAt, scanner]);

  const entries = useMemo(() => {
    const remoteRows = new Map(remoteResult?.rows.map((row) => [row.id, row]) ?? []);
    const cohort: ScanProject[] = JSON.parse(cohortKey);
    const entries = Object.fromEntries(cohort.map((project) => {
      const local = stored[project.id];
      const value = local?.path === project.path ? local.value : active ? LOADING_ENTRY : IDLE_ENTRY;
      const remote = remoteRows.get(project.id);
      const remoteError = remote?.path === project.path ? remote.error : null;
      const old = projectedEntries.current[project.id];
      const entry = value.remoteError === remoteError ? value
        : old?.summary === value.summary && old.error === value.error && old.checking === value.checking && old.remoteError === remoteError
          ? old : { ...value, remoteError };
      return [project.id, entry];
    })) as Record<string, OverviewEntry>;
    projectedEntries.current = entries;
    return entries;
  }, [active, cohortKey, stored, remoteResult]);
  return { entries, refreshing, refresh };
}
