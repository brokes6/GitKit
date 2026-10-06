import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Project } from "./App";
import type { CheckResult } from "./dailyCheck";
import { configureProjectWatch, loadProjectOverview, loadProjectStatusSummary, type WorkingTreeChanged } from "./git";
import { createProjectReadQueue } from "./projectReadQueue";
import {
  projectReadTargets, projectRemoteRowsKey, type OverviewEntry, type ProjectOverviewSummary,
  type ProjectReadContext, type ProjectStatusEntry, type ProjectStatusSummary,
} from "./projectOverview";

export interface ProjectOverviewOptions {
  foreground: boolean;
  foregroundRevision?: number;
  full: boolean;
  activePath: string;
  isLiveWatched?: (path: string) => boolean;
  reconcileLiveStatus?: (path: string) => void;
}
interface ReadPlan {
  key: string;
  context: ProjectReadContext;
  revisions: ReadonlyMap<string, number>;
  serial: number;
  activation: number;
}
interface StoredRead<T> { revision: number; value: T }
interface StoredEntry { status: StoredRead<ProjectStatusEntry>; full?: StoredRead<OverviewEntry> }
interface ReadOutcome {
  summary: ProjectStatusSummary | ProjectOverviewSummary | null;
  full: boolean;
  revision: number;
  readRevision: number;
  error: string | null;
  skip?: boolean;
}
interface WatchRegistration { activation: number; listenerGeneration: number; paths: readonly string[]; failedPaths: readonly string[] }
const IDLE_ENTRY: OverviewEntry = { summary: null, error: null, checking: false, remoteError: null };
let lastWatchRevision = Date.now();
const nextWatchRevision = () => (lastWatchRevision = Math.max(Date.now(), lastWatchRevision + 1));

function revisePlan(plan: ReadPlan, targets: readonly string[]): ReadPlan {
  if (!targets.length) return plan;
  const revisions = new Map(plan.revisions);
  const paths = new Set(plan.context.paths);
  let serial = plan.serial;
  for (const path of new Set(targets)) if (paths.has(path)) revisions.set(path, ++serial);
  return serial === plan.serial ? plan : { ...plan, revisions, serial };
}
function transitionPlan(previous: ReadPlan | null, context: ProjectReadContext, key: string): ReadPlan {
  const revisions = new Map([...previous?.revisions ?? []].filter(([path]) => context.paths.includes(path)));
  const plan: ReadPlan = {
    key, context, revisions, serial: previous?.serial ?? 0,
    activation: (previous?.activation ?? 0) + (context.running && (!previous?.context.running
      || (context.foregroundRevision ?? 0) !== (previous.context.foregroundRevision ?? 0)) ? 1 : 0),
  };
  return revisePlan(plan, projectReadTargets(previous?.context ?? null, context));
}
function sameEntry(left: ProjectStatusEntry | undefined, right: ProjectStatusEntry): boolean {
  return !!left && left.summary === right.summary && left.error === right.error && left.checking === right.checking
    && left.remoteError === right.remoteError && left.readRevision === right.readRevision && left.readPath === right.readPath;
}

export function useProjectOverview(
  projects: Project[], active: boolean, revision: number | string, remoteResult: CheckResult | null,
  liveRevisions?: ReadonlyMap<string, number>, options?: ProjectOverviewOptions,
) {
  const foreground = options?.foreground ?? true;
  const full = options?.full ?? true;
  const running = active && foreground && isTauri();
  const pathsKey = JSON.stringify([...new Set(projects.map(({ path }) => path))].sort());
  const paths: string[] = useMemo(() => JSON.parse(pathsKey), [pathsKey]);
  const cohortKey = JSON.stringify(projects.map(({ id, path }) => [id, path]));
  const context: ProjectReadContext = {
    paths, running, full, foregroundRevision: options?.foregroundRevision ?? 0,
    activePath: options?.activePath ?? "", revision, remoteRows: remoteResult?.rows ?? [],
  };
  const inputKey = JSON.stringify([pathsKey, running, full, context.foregroundRevision, context.activePath, revision, projectRemoteRowsKey(context.remoteRows)]);
  const [plan, setPlan] = useState(() => transitionPlan(null, context, inputKey));
  // Project cached reads as pending in this render, before effects can write badges.
  let currentPlan = plan;
  if (plan.key !== inputKey) {
    currentPlan = transitionPlan(plan, context, inputKey);
    setPlan(currentPlan);
  }
  const [stored, setStored] = useState<Record<string, StoredEntry>>({});
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState<WatchRegistration | null>(null);
  const [attachedListener, setAttachedListener] = useState<{ activation: number; generation: number } | null>(null);
  const registrationRef = useRef(registration);
  registrationRef.current = registration;
  const mounted = useRef(false);
  const runtime = useRef({ plan: currentPlan, liveRevisions, isLiveWatched: options?.isLiveWatched, reconcileLiveStatus: options?.reconcileLiveStatus });
  runtime.current = { plan: currentPlan, liveRevisions, isLiveWatched: options?.isLiveWatched, reconcileLiveStatus: options?.reconcileLiveStatus };
  const enqueued = useRef(new Map<string, number>());
  const listenerReady = useRef<Promise<UnlistenFn> | null>(null);
  const listenerGeneration = useRef(0);
  const projected = useRef<{ full: Record<string, OverviewEntry>; status: Record<string, ProjectStatusEntry> }>({ full: {}, status: {} });
  const invalidate = useCallback((targets: readonly string[]) => {
    if (mounted.current && runtime.current.plan.context.running) setPlan((previous) => revisePlan(previous, targets));
  }, []);
  const refresh = useCallback(() => invalidate(runtime.current.plan.context.paths), [invalidate]);
  const queueRef = useRef<ReturnType<typeof createProjectReadQueue<ReadOutcome>> | null>(null);
  if (!queueRef.current) queueRef.current = createProjectReadQueue<ReadOutcome>(async (path) => {
    const current = runtime.current;
    const readRevision = current.liveRevisions?.get(path) ?? 0;
    const requestRevision = current.plan.revisions.get(path) ?? 0;
    const readFull = current.plan.context.full;
    if (!readFull && (path === current.plan.context.activePath || current.isLiveWatched?.(path))) {
      return { summary: null, full: false, revision: requestRevision, readRevision, error: null, skip: true };
    }
    try {
      const summary = await (readFull ? loadProjectOverview(path) : loadProjectStatusSummary(path));
      return { summary, full: readFull, revision: requestRevision, readRevision, error: null };
    } catch (error) {
      return { summary: null, full: readFull, revision: requestRevision, readRevision,
        error: error instanceof Error ? error.message : String(error) };
    }
  }, {
    concurrency: 3, minReadIntervalMs: 1000,
    onBusyChange: (next) => { if (mounted.current) setBusy(next); },
    onBatch: (results) => {
      if (!mounted.current || !runtime.current.plan.context.running) return;
      setStored((previous) => {
        if (!mounted.current || !runtime.current.plan.context.running) return previous;
        const wanted = runtime.current.plan.revisions;
        let next = previous;
        for (const { path, value } of results) {
          if (!value || wanted.get(path) !== value.revision) continue;
          if (next === previous) next = { ...previous };
          const old = previous[path];
          const status: ProjectStatusEntry = {
            summary: value.summary ?? old?.status.value.summary ?? null,
            error: value.error, checking: false, remoteError: null, readPath: path,
            // A live-owned skip is not a fresh read of its retained snapshot.
            readRevision: value.skip ? undefined : value.readRevision,
          };
          const fullEntry: OverviewEntry | undefined = value.full ? {
            ...status, summary: (value.summary as ProjectOverviewSummary | null) ?? old?.full?.value.summary ?? null,
          } : old?.full?.value;
          next[path] = {
            status: { revision: value.revision, value: status },
            full: value.full && fullEntry ? { revision: value.revision, value: fullEntry } : old?.full,
          };
        }
        return next;
      });
    },
  });
  const queue = queueRef.current;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Keep physical slots until completion: effect replay must never exceed pool3.
      queue.setActive(false);
      queue.setPaths([]);
      enqueued.current.clear();
    };
  }, [queue]);

  useEffect(() => {
    if (!running) return;
    const generation = ++listenerGeneration.current;
    const activation = currentPlan.activation;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    const promise = listen<WorkingTreeChanged>("working-tree-changed", ({ payload }) => {
      const current = runtime.current;
      if (!current.plan.context.running || !current.plan.revisions.has(payload.path)) return;
      if (!current.plan.context.full && (payload.path === current.plan.context.activePath || current.isLiveWatched?.(payload.path))) return;
      invalidate([payload.path]);
    });
    listenerReady.current = promise;
    void promise.then((remove) => {
      if (cancelled) remove();
      else { unlisten = remove; setAttachedListener({ activation, generation }); }
    }, () => {
      // Reads still work without events; all paths then use the failed-watch fallback.
      if (!cancelled) setAttachedListener({ activation, generation });
    });
    return () => {
      cancelled = true;
      unlisten?.();
      if (listenerReady.current === promise) listenerReady.current = null;
      // Native rejects late older configurations, including teardown requests.
      void configureProjectWatch([], false, nextWatchRevision()).catch(() => {});
    };
  }, [running, currentPlan.activation, invalidate]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const activation = currentPlan.activation;
    const generation = listenerGeneration.current;
    const watchRevision = nextWatchRevision();
    const registeredPaths = paths;
    const prior = registrationRef.current;
    const covered = prior?.activation === activation && prior.listenerGeneration === generation
      ? new Set(prior.paths.filter((path) => !prior.failedPaths.includes(path))) : new Set<string>();
    void (async () => {
      let failedPaths: readonly string[] = registeredPaths;
      try {
        await listenerReady.current;
        if (cancelled) return;
        const result = await configureProjectWatch([...registeredPaths], true, watchRevision);
        if (result.revision === watchRevision) {
          failedPaths = result.failedPaths;
          if (!cancelled) {
            const current = runtime.current;
            // Reads may start before registration finishes. Reconcile newly watched
            // paths once to cover an edit between their first read and watch setup.
            invalidate(registeredPaths.filter((path) => !covered.has(path) && !failedPaths.includes(path)
              && (current.plan.context.full || (path !== current.plan.context.activePath && !current.isLiveWatched?.(path)))));
          }
        } else lastWatchRevision = Math.max(lastWatchRevision, result.revision);
      } catch { /* A failed observer uses targeted foreground reconciliation. */ }
      if (!cancelled) setRegistration({ activation, listenerGeneration: generation, paths: registeredPaths, failedPaths });
    })();
    return () => { cancelled = true; };
  }, [running, currentPlan.activation, pathsKey, invalidate]);

  useEffect(() => {
    const allowed = running && attachedListener?.activation === currentPlan.activation && attachedListener.generation === listenerGeneration.current
      ? paths : [];
    if (!running || !allowed.length) queue.setActive(false);
    queue.setPaths(allowed);
    const desired = currentPlan.revisions;
    const previous = enqueued.current;
    const targets = allowed.filter((path) => previous.has(path) && previous.get(path) !== desired.get(path));
    enqueued.current = new Map(allowed.map((path) => [path, desired.get(path) ?? 0]));
    if (targets.length) queue.refresh(targets);
    queue.setActive(running && allowed.length > 0);
  }, [queue, running, pathsKey, attachedListener, currentPlan.activation, currentPlan.revisions]);

  useEffect(() => {
    if (!running || registration?.activation !== currentPlan.activation || registration.listenerGeneration !== listenerGeneration.current || !registration.failedPaths.length) return;
    const fallbackPaths = registration.failedPaths.filter((path) => paths.includes(path));
    if (!fallbackPaths.length) return;
    const timer = setInterval(() => {
      const current = runtime.current;
      const targets: string[] = [];
      for (const path of fallbackPaths) {
        if (!current.plan.context.full && (path === current.plan.context.activePath || current.isLiveWatched?.(path))) {
          current.reconcileLiveStatus?.(path);
        } else targets.push(path);
      }
      invalidate(targets);
    }, 3000);
    return () => clearInterval(timer);
  }, [running, registration, currentPlan.activation, pathsKey, invalidate]);

  useEffect(() => {
    if (options || !running) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [!!options, running, refresh]);

  useEffect(() => {
    setStored((previous) => {
      const retained = Object.fromEntries(Object.entries(previous).filter(([path]) => paths.includes(path)));
      return Object.keys(retained).length === Object.keys(previous).length ? previous : retained;
    });
  }, [pathsKey]);

  const { entries, statusEntries } = useMemo(() => {
    const remoteRows = new Map(remoteResult?.rows.map((row) => [row.id, row]) ?? []);
    const entries: Record<string, OverviewEntry> = {};
    const statusEntries: Record<string, ProjectStatusEntry> = {};
    const cohort: [string, string][] = JSON.parse(cohortKey);
    for (const [id, path] of cohort) {
      const remote = remoteRows.get(id);
      const remoteError = remote?.path === path ? remote.error : null;
      const local = stored[path];
      const wanted = currentPlan.revisions.get(path);
      const statusValue: ProjectStatusEntry = { ...(local?.status.value ?? IDLE_ENTRY), remoteError,
        checking: running && local?.status.revision !== wanted };
      const fullValue: OverviewEntry = { ...(local?.full?.value ?? IDLE_ENTRY), remoteError,
        checking: running && full && local?.full?.revision !== wanted };
      statusEntries[id] = sameEntry(projected.current.status[id], statusValue) ? projected.current.status[id] : statusValue;
      entries[id] = sameEntry(projected.current.full[id], fullValue) ? projected.current.full[id] : fullValue;
    }
    projected.current = { full: entries, status: statusEntries };
    return { entries, statusEntries };
  }, [cohortKey, stored, remoteResult, currentPlan.revisions, full, running]);
  const pending = running && paths.some((path) => stored[path]?.status.revision !== currentPlan.revisions.get(path));
  return { entries, statusEntries, refreshing: running && (busy || pending), refresh };
}
