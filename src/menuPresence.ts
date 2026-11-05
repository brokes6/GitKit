import { useEffect, useRef, useState } from "react";

export const MENU_EXIT_MS = 140;

/**
 * Keep a popup's last value alive for the length of its exit animation.
 * `shown` is the value to render (null once fully gone); `closing` is true while
 * the exit animation should play. Reopening during the exit cancels it.
 */
export function useExitPresence<T>(value: T | null, ms = MENU_EXIT_MS): { shown: T | null; closing: boolean } {
  const last = useRef<T | null>(null);
  const [, rerender] = useState(0);
  if (value) last.current = value;
  const closing = !value && last.current !== null;
  useEffect(() => {
    if (!closing) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => { last.current = null; rerender((n) => n + 1); }, reduce ? 0 : ms);
    return () => window.clearTimeout(timer);
  }, [closing, ms]);
  return { shown: value ?? last.current, closing };
}
