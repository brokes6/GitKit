import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "./App";
import type { CheckResult } from "./dailyCheck";
import { loadProjectActivity } from "./git";
import { createOverviewScanner } from "./overviewScanner";
import { activityAuthorEmails, activityEntryForScope, createActivityCache, createActivityWindow } from "./projectActivity";
import type { ActivityEntry, ActivityRequest, ProjectActivitySummary, StoredActivityEntry } from "./projectActivity";

interface ScanProject { id: string; path: string }
const IDLE_ENTRY: ActivityEntry = { summary: null, error: null, checking: false };
const LOADING_ENTRY: ActivityEntry = { ...IDLE_ENTRY, checking: true };

export function useProjectActivity(projects: Project[], identities: readonly { email: string }[], active: boolean, revision: number, remoteResult: CheckResult | null) {
  const [stored, setStored] = useState<Record<string, StoredActivityEntry>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [, setCalendarRevision] = useState(0);
  const calculatedWindow = createActivityWindow();
  const window = useMemo(() => calculatedWindow, [calculatedWindow.key]);
  const cohortKey = JSON.stringify(projects.map(({ id, path }) => ({ id, path })));
  const identityKey = JSON.stringify(activityAuthorEmails(identities));
  const authorEmails = useMemo<string[]>(() => JSON.parse(identityKey), [identityKey]);
  const hasIdentities = authorEmails.length > 0;
  const scopeKey = `${window.key}:${identityKey}`;
  const requestKey = `${scopeKey}:${revision}:${remoteResult?.id ?? 0}:${remoteResult?.completedAt ?? 0}:${refreshRevision}`;
  const requestRef = useRef<ActivityRequest>({ key: requestKey, window, authorEmails });
  const cacheRef = useRef<ReturnType<typeof createActivityCache> | null>(null);
  if (!cacheRef.current) cacheRef.current = createActivityCache(loadProjectActivity);
  const cache = cacheRef.current;
  const scannerRef = useRef<ReturnType<typeof createOverviewScanner<ScanProject, ProjectActivitySummary>> | null>(null);
  if (!scannerRef.current) scannerRef.current = createOverviewScanner<ScanProject, ProjectActivitySummary>((path) => cache.read(path, requestRef.current));
  const scanner = scannerRef.current;
  const refresh = useCallback(() => setRefreshRevision((value) => value + 1), []);

  useEffect(() => {
    if (!active) return;
    const updateDay = () => setCalendarRevision((value) => value + 1);
    const onFocus = () => { updateDay(); refresh(); };
    globalThis.addEventListener("focus", onFocus);
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 20);
    const timer = globalThis.setTimeout(updateDay, Math.max(1, tomorrow.getTime() - Date.now()));
    return () => { globalThis.removeEventListener("focus", onFocus); clearTimeout(timer); };
  }, [active, window.key, refresh]);

  useEffect(() => {
    let disposed = false;
    const cohort: ScanProject[] = JSON.parse(cohortKey);
    cache.retain(cohort.map((project) => project.path));
    requestRef.current = { key: requestKey, window, authorEmails };
    const pendingPaths = new Set<string>();
    const pending = active && hasIdentities ? cohort.filter((project) => {
      if (cache.get(project.path, requestKey) || pendingPaths.has(project.path)) return false;
      pendingPaths.add(project.path);
      return true;
    }) : [];
    setRefreshing(pending.length > 0);
    setStored((previous) => {
      const next: Record<string, StoredActivityEntry> = {};
      for (const project of cohort) {
        const old = activityEntryForScope(previous[project.id], project.path, scopeKey) ?? IDLE_ENTRY;
        const cached = cache.get(project.path, requestKey);
        next[project.id] = { path: project.path, scopeKey, value: {
          summary: cached?.summary ?? old.summary,
          error: cached ? cached.error : old.error,
          checking: active && hasIdentities && !cached,
        } };
      }
      return next;
    });
    if (!pending.length) return;
    const scan = scanner.start(pending, {
      onBatch: (results) => setStored((previous) => {
        if (disposed) return previous;
        const next = { ...previous };
        for (const { project, summary, error } of results) {
          // A shared checkout can appear more than once in the project list.
          for (const member of cohort) {
            if (member.path !== project.path || next[member.id]?.path !== member.path) continue;
            next[member.id] = { path: member.path, scopeKey, value: {
              summary: summary ?? next[member.id].value.summary, error, checking: false,
            } };
          }
        }
        return next;
      }),
      onComplete: () => { if (!disposed) setRefreshing(false); },
    });
    return () => { disposed = true; scan.cancel(); };
  }, [active, cohortKey, requestKey, scopeKey, window, authorEmails, hasIdentities, cache, scanner]);

  const entries = useMemo(() => Object.fromEntries((JSON.parse(cohortKey) as ScanProject[]).map((project) => {
    return [project.id, activityEntryForScope(stored[project.id], project.path, scopeKey)
      ?? (active && hasIdentities ? LOADING_ENTRY : IDLE_ENTRY)];
  })), [cohortKey, stored, active, hasIdentities, scopeKey]);
  return { entries, window, refreshing, refresh, hasIdentities };
}
