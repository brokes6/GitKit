import { languageForDiffPath } from "./diffLanguages";

export type DiffSyntaxRow = { kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string };
export type DiffSyntaxToken = { content: string; color?: string };
export type DiffSyntaxPalette = {
  name: string; dark: boolean; text: string; muted: string;
  keyword: string; string: string; number: string; function: string; type: string;
};

type TokenRows = DiffSyntaxToken[][];
type Task = {
  id: number; key: string; consumers: number; settled: boolean;
  promise: Promise<TokenRows | null>; resolve: (tokens: TokenRows | null) => void;
};

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_FILES = 4;
const WORKER_IDLE_MS = 120_000;

let worker: Worker | null = null;
let workerIdleTimer: number | null = null;
let nextId = 0;
let cacheBytes = 0;
const tasksById = new Map<number, Task>();
const tasksByKey = new Map<string, Task>();
const cache = new Map<string, { tokens: TokenRows; bytes: number }>();

function tokenBytes(key: string, tokens: TokenRows) {
  let bytes = key.length * 2;
  for (const line of tokens) {
    for (const token of line) bytes += token.content.length * 2 + 64;
  }
  return bytes;
}

function cacheTokens(key: string, tokens: TokenRows) {
  const bytes = tokenBytes(key, tokens);
  if (bytes > MAX_CACHE_BYTES) return;
  cache.set(key, { tokens, bytes });
  cacheBytes += bytes;
  while (cache.size > MAX_CACHE_FILES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

function scheduleWorkerIdle() {
  if (workerIdleTimer !== null) window.clearTimeout(workerIdleTimer);
  if (!worker || tasksById.size) return;
  workerIdleTimer = window.setTimeout(() => {
    if (!tasksById.size) {
      worker?.terminate();
      worker = null;
    }
    workerIdleTimer = null;
  }, WORKER_IDLE_MS);
}

function finishTask(task: Task, tokens: TokenRows | null, shouldCache = true) {
  if (task.settled) return;
  task.settled = true;
  tasksById.delete(task.id);
  tasksByKey.delete(task.key);
  if (tokens && shouldCache) cacheTokens(task.key, tokens);
  task.resolve(tokens);
  scheduleWorkerIdle();
}

function getWorker(): Worker | null {
  if (workerIdleTimer !== null) window.clearTimeout(workerIdleTimer);
  workerIdleTimer = null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./diffSyntax.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; tokens: TokenRows | null }>) => {
      const task = tasksById.get(event.data.id);
      if (task) finishTask(task, event.data.tokens);
    };
    worker.onerror = () => {
      const failedWorker = worker;
      worker = null;
      if (workerIdleTimer !== null) window.clearTimeout(workerIdleTimer);
      workerIdleTimer = null;
      for (const task of [...tasksById.values()]) finishTask(task, null, false);
      failedWorker?.terminate();
    };
    return worker;
  } catch {
    return null;
  }
}

function subscribe(task: Task, signal: AbortSignal): Promise<TokenRows | null> {
  if (signal.aborted) return Promise.resolve(null);
  task.consumers++;
  return new Promise((resolve) => {
    let done = false;
    const complete = (tokens: TokenRows | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      task.consumers--;
      resolve(tokens);
      if (!task.consumers && !task.settled) {
        worker?.postMessage({ type: "cancel", id: task.id });
        finishTask(task, null, false);
      }
    };
    const onAbort = () => complete(null);
    signal.addEventListener("abort", onAbort, { once: true });
    task.promise.then(complete);
    if (signal.aborted) onAbort();
  });
}

export function highlightDiffRows(rows: DiffSyntaxRow[], filePath: string,
  palette: DiffSyntaxPalette, key: string, signal: AbortSignal): Promise<TokenRows | null> {
  if (signal.aborted || !languageForDiffPath(filePath)) return Promise.resolve(null);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached.tokens);
  }
  const existing = tasksByKey.get(key);
  if (existing) return subscribe(existing, signal);
  const currentWorker = getWorker();
  if (!currentWorker) return Promise.resolve(null);
  let resolve!: Task["resolve"];
  const promise = new Promise<TokenRows | null>((done) => { resolve = done; });
  const task: Task = { id: ++nextId, key, consumers: 0, settled: false, promise, resolve };
  tasksById.set(task.id, task);
  tasksByKey.set(key, task);
  const subscription = subscribe(task, signal);
  if (!task.settled) currentWorker.postMessage({ type: "highlight", id: task.id, rows, filePath, palette });
  return subscription;
}
