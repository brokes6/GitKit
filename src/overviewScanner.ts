import type { ProjectOverviewSummary } from "./projectOverview";

interface ScanProject { id: string; path: string }
export interface OverviewScanResult<T extends ScanProject> {
  project: T;
  summary: ProjectOverviewSummary | null;
  error: string | null;
}
interface ScanObserver<T extends ScanProject> {
  onBatch: (results: OverviewScanResult<T>[]) => void;
  onComplete: () => void;
}
interface ScanRound<T extends ScanProject> {
  pending: T[];
  running: number;
  batch: OverviewScanResult<T>[];
  timer: ReturnType<typeof setTimeout> | null;
  observer: ScanObserver<T> | null;
  settle: (completed: boolean) => void;
}

/** Keep native reads in the same pool even after their UI generation is cancelled. */
export function createOverviewScanner<T extends ScanProject>(
  load: (path: string) => Promise<ProjectOverviewSummary>,
  concurrency = 3,
  batchDelay = 32,
) {
  const limit = Math.max(1, Math.floor(concurrency));
  const runningPaths = new Set<string>();
  let current: ScanRound<T> | null = null;

  const clearTimer = (round: ScanRound<T>) => {
    if (round.timer !== null) clearTimeout(round.timer);
    round.timer = null;
  };
  const cancel = (round: ScanRound<T>) => {
    if (!round.observer) return;
    clearTimer(round);
    round.pending = [];
    round.batch = [];
    round.observer = null;
    if (current === round) current = null;
    round.settle(false);
  };
  const flush = (round: ScanRound<T>) => {
    clearTimer(round);
    if (current !== round || !round.observer || !round.batch.length) return;
    const results = round.batch;
    round.batch = [];
    round.observer.onBatch(results);
  };
  const complete = (round: ScanRound<T>) => {
    if (current !== round || !round.observer || round.pending.length || round.running) return;
    flush(round);
    // An observer may have requested another generation while applying its batch.
    if (current !== round || !round.observer) return;
    const observer = round.observer;
    round.observer = null;
    current = null;
    observer.onComplete();
    round.settle(true);
  };
  const pump = () => {
    const round = current;
    if (!round?.observer) return;
    while (runningPaths.size < limit) {
      // A replacement round must not overlap an old read of the same repository.
      const index = round.pending.findIndex((project) => !runningPaths.has(project.path));
      if (index < 0) break;
      const [project] = round.pending.splice(index, 1);
      runningPaths.add(project.path);
      round.running++;
      const finish = (summary: ProjectOverviewSummary | null, error: string | null) => {
        runningPaths.delete(project.path);
        round.running--;
        if (current === round && round.observer) {
          round.batch.push({ project, summary, error });
          if (round.timer === null) round.timer = setTimeout(() => flush(round), batchDelay);
          complete(round);
        }
        // Obsolete calls still release slots for the latest queued generation.
        pump();
      };
      void Promise.resolve().then(() => load(project.path)).then(
        (summary) => finish(summary, null),
        (cause) => finish(null, cause instanceof Error ? cause.message : String(cause)),
      );
    }
    complete(round);
  };

  return {
    start(projects: readonly T[], observer: ScanObserver<T>) {
      if (current) cancel(current);
      let settle!: (completed: boolean) => void;
      const done = new Promise<boolean>((resolve) => { settle = resolve; });
      const round: ScanRound<T> = {
        pending: [...projects], running: 0, batch: [], timer: null, observer, settle,
      };
      current = round;
      pump();
      return { done, cancel: () => cancel(round) };
    },
  };
}
