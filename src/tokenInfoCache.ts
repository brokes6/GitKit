export interface TokenInfoSnapshot<T> {
  info: T | null;
  error: string;
  checkedAt: number;
}

export interface TokenInfoCacheOptions {
  successTtlMs?: number;
  errorTtlMs?: number;
  maxEntries?: number;
  maxConcurrent?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  snapshot: TokenInfoSnapshot<T> | null;
  ttlMs: number;
  generation: number;
  pendingGeneration: number;
  pending: Promise<TokenInfoSnapshot<T>> | null;
}

/** Session-only metadata; credential keys are never persisted or logged. */
export function createTokenInfoCache<T>(
  loader: (url: string, token: string) => Promise<T>,
  options: TokenInfoCacheOptions = {},
) {
  const finite = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
  const successTtlMs = finite(options.successTtlMs, 5 * 60_000);
  const errorTtlMs = finite(options.errorTtlMs, 30_000);
  const maxEntries = Math.max(1, Math.floor(finite(options.maxEntries, 32)));
  const maxConcurrent = Math.max(1, Math.floor(finite(options.maxConcurrent, 3)));
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry<T>>();
  let running = 0;
  const queued: Array<() => void> = [];
  const pump = () => {
    while (running < maxConcurrent && queued.length) queued.shift()!();
  };
  const request = (url: string, token: string): Promise<T> => new Promise((resolve, reject) => {
    queued.push(() => {
      running++;
      Promise.resolve().then(() => loader(url, token)).then(resolve, reject).then(() => {
        running--;
        pump();
      });
    });
    pump();
  });
  const credentials = (url: string, token: string) => {
    const normalized = { url: url.trim().replace(/\/+$/, ""), token: token.trim() };
    return { ...normalized, key: JSON.stringify([normalized.url, normalized.token]) };
  };
  const touch = (key: string, entry: CacheEntry<T>) => {
    entries.delete(key);
    entries.set(key, entry);
  };
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) break;
      // Never evict active requests: doing so would allow a duplicate request
      // for the same credentials. A burst of pending keys can temporarily
      // exceed the limit; each completion trims it back toward the bound.
      if (!entry.pending) entries.delete(key);
    }
  };
  const fresh = (entry: CacheEntry<T> | undefined) => {
    if (!entry?.snapshot || entry.pending) return false;
    const age = now() - entry.snapshot.checkedAt;
    return age >= 0 && age < entry.ttlMs;
  };

  function read(url: string, token: string): TokenInfoSnapshot<T> | null {
    const { key } = credentials(url, token);
    const entry = entries.get(key);
    if (!entry) return null;
    touch(key, entry);
    return entry.snapshot;
  }

  function isFresh(url: string, token: string): boolean {
    return fresh(entries.get(credentials(url, token).key));
  }

  function load(url: string, token: string, force = false): Promise<TokenInfoSnapshot<T>> {
    const normalized = credentials(url, token);
    const { key } = normalized;
    let entry = entries.get(key);
    if (entry) {
      touch(key, entry);
      if (entry.pending) {
        if (entry.pendingGeneration === entry.generation) return entry.pending;
        // Invalidation keeps the old request tracked but rejects its cache
        // write. Wait before starting the new generation, then deduplicate
        // other waiters through the same load path.
        return entry.pending.then(() => load(normalized.url, normalized.token, force));
      }
      if (!force && fresh(entry)) return Promise.resolve(entry.snapshot!);
    } else {
      entry = { snapshot: null, ttlMs: 0, generation: 0, pendingGeneration: 0, pending: null };
      entries.set(key, entry);
    }
    const target = entry;
    const generation = target.generation;
    target.pendingGeneration = generation;
    const pending = request(normalized.url, normalized.token).then(
      (info) => ({ snapshot: { info, error: "", checkedAt: now() }, ttlMs: successTtlMs }),
      (error: unknown) => ({ snapshot: { info: null, error: String(error), checkedAt: now() }, ttlMs: errorTtlMs }),
    ).then(({ snapshot, ttlMs }) => {
      if (entries.get(key) === target && target.generation === generation) {
        target.snapshot = snapshot;
        target.ttlMs = ttlMs;
        touch(key, target);
      }
      if (target.pending === pending) target.pending = null;
      trim();
      return snapshot;
    });
    target.pending = pending;
    trim();
    return pending;
  }

  function invalidate(url: string, token: string): void {
    const { key } = credentials(url, token);
    const entry = entries.get(key);
    if (!entry) return;
    if (!entry.pending) {
      entries.delete(key);
      return;
    }
    entry.snapshot = null;
    entry.generation++;
  }

  return { read, isFresh, load, invalidate };
}
