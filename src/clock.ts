import { useEffect, useRef } from "react";

// One shared timer for everything that shows time-relative text. It only runs
// while someone is subscribed and the app is in the foreground, and fires once
// on returning to the foreground to catch up on whatever elapsed meanwhile.
export const CLOCK_TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let active = true;

function emit() {
  for (const listener of [...listeners]) listener();
}

function sync() {
  const wanted = active && listeners.size > 0;
  if (wanted && timer === null) timer = setInterval(emit, CLOCK_TICK_MS);
  else if (!wanted && timer !== null) { clearInterval(timer); timer = null; }
}

export function setClockActive(next: boolean) {
  if (active === next) return;
  active = next;
  sync();
  if (next) emit();
}

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  sync();
  return () => { listeners.delete(listener); sync(); };
}

/** Run `callback` on every clock tick while mounted. */
export function useClockTick(callback: () => void) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => subscribeClock(() => latest.current()), []);
}
