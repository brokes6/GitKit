export interface ProjectReadResult<Value> {
  path: string;
  value: Value | null;
  error: string | null;
}

export interface ProjectReadQueueOptions<Value> {
  onBatch: (results: ProjectReadResult<Value>[]) => void;
  onBusyChange?: (busy: boolean) => void;
  concurrency?: number;
  batchDelay?: number;
  minReadIntervalMs?: number;
}

interface PathState { revision: number }
interface ReadJob { path: string; state: PathState; revision: number }
interface ReadyRead<Value> { job: ReadJob; result: ProjectReadResult<Value> }

/** Targeted native reads. Pausing retains dirty paths and physical in-flight slots. */
export function createProjectReadQueue<Value>(
  load: (path: string) => Promise<Value>,
  options: ProjectReadQueueOptions<Value>,
) {
  const finite = (value: number | undefined, fallback: number) =>
    value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);
  const limit = Math.max(1, Math.floor(finite(options.concurrency, 3)));
  const batchDelay = finite(options.batchDelay, 32);
  const minInterval = finite(options.minReadIntervalMs, 0);
  const now = () => performance.now();
  let paths = new Map<string, PathState>();
  const dirty = new Set<string>();
  const running = new Map<string, ReadJob>();
  const lastStarted = new Map<string, number>();
  const ready = new Map<string, ReadyRead<Value>>();
  let active = false;
  let disposed = false;
  let busy = false;
  let pumping = false;
  let pumpAgain = false;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeAt: number | null = null;

  const current = (job: ReadJob) => paths.get(job.path) === job.state && job.state.revision === job.revision;
  const clearBatch = () => {
    if (batchTimer !== null) clearTimeout(batchTimer);
    batchTimer = null;
  };
  const clearWake = () => {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    wakeAt = null;
  };
  const publishBusy = () => {
    const next = !disposed && active && (dirty.size > 0 || ready.size > 0
      || [...running.keys()].some((path) => paths.has(path)));
    if (next === busy) return;
    busy = next;
    options.onBusyChange?.(next);
  };
  const flush = () => {
    clearBatch();
    if (disposed || !active) return;
    const results = [...ready.values()]
      .filter(({ job }) => current(job))
      .map(({ result }) => result);
    ready.clear();
    if (results.length) options.onBatch(results);
  };
  const wake = (at: number | null) => {
    if (at === null) { clearWake(); return; }
    if (wakeTimer !== null && wakeAt === at) return;
    clearWake();
    wakeAt = at;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      wakeAt = null;
      pump();
    }, Math.max(1, at - now()));
  };
  const finish = (job: ReadJob, value: Value | null, error: string | null, loaded: boolean) => {
    if (running.get(job.path) !== job) return;
    running.delete(job.path);
    if (!paths.has(job.path)) lastStarted.delete(job.path);
    if (disposed) return;
    if (loaded && active && current(job)) {
      ready.set(job.path, { job, result: { path: job.path, value, error } });
      if (batchTimer === null) batchTimer = setTimeout(() => { flush(); pump(); }, batchDelay);
    } else if (paths.has(job.path)) {
      dirty.add(job.path);
    }
    pump();
  };
  const start = (path: string, state: PathState) => {
    const job = { path, state, revision: state.revision };
    dirty.delete(path);
    running.set(path, job);
    void Promise.resolve().then(() => {
      // An invalidation can arrive before the native call starts in this turn.
      if (disposed || !active || !current(job)) { finish(job, null, null, false); return; }
      lastStarted.set(path, now());
      return load(path).then(
        (value) => finish(job, value, null, true),
        (cause) => finish(job, null, cause instanceof Error ? cause.message : String(cause), true),
      );
    }).catch((cause) => finish(job, null, cause instanceof Error ? cause.message : String(cause), true));
  };
  function pump() {
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        let nextWake: number | null = null;
        if (!disposed && active) {
          for (const path of dirty) {
            if (running.size >= limit) break;
            const state = paths.get(path);
            if (!state) { dirty.delete(path); continue; }
            if (running.has(path)) continue;
            const last = lastStarted.get(path);
            const eligible = last === undefined ? 0 : last + minInterval;
            if (eligible > now()) {
              nextWake = nextWake === null ? eligible : Math.min(nextWake, eligible);
            } else {
              start(path, state);
            }
          }
          // A full physical pool must be released by a completion, not a timer.
          wake(running.size < limit ? nextWake : null);
          if (!dirty.size && ![...running.keys()].some((path) => paths.has(path))) flush();
        } else {
          clearWake();
        }
        publishBusy();
      } while (pumpAgain);
    } finally { pumping = false; }
  }

  return {
    get busy() { return busy; },
    setPaths(nextPaths: readonly string[]) {
      if (disposed) return;
      const next = new Map<string, PathState>();
      for (const path of nextPaths) {
        if (next.has(path)) continue;
        const previous = paths.get(path);
        next.set(path, previous ?? { revision: 0 });
        if (!previous) dirty.add(path);
      }
      for (const path of paths.keys()) {
        if (next.has(path)) continue;
        dirty.delete(path);
        ready.delete(path);
        if (!running.has(path)) lastStarted.delete(path);
      }
      paths = next;
      if (!ready.size) clearBatch();
      pump();
    },
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      if (!active) {
        const interrupted = new Set([...running.keys(), ...ready.keys()]);
        for (const path of interrupted) {
          const state = paths.get(path);
          if (!state) continue;
          state.revision++;
          dirty.add(path);
        }
        ready.clear();
        clearBatch();
        clearWake();
      }
      pump();
    },
    refresh(selectedPaths?: readonly string[]) {
      if (disposed) return;
      for (const path of new Set(selectedPaths ?? paths.keys())) {
        const state = paths.get(path);
        if (!state) continue;
        state.revision++;
        dirty.add(path);
        ready.delete(path);
      }
      if (!ready.size) clearBatch();
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      paths.clear();
      dirty.clear();
      ready.clear();
      lastStarted.clear();
      clearBatch();
      clearWake();
      publishBusy();
    },
  };
}
